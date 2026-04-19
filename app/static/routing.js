/* Routing engine (client half).
 *
 * Sends requests to /api/route in one of two shapes per side:
 *   Indoor (from MaristIndoor.snapshot()):
 *     ?from_kind=room&from_building=Hancock&from_room=1021
 *     ?from_kind=entrance&from_building=Dyson&from_name=Main
 *     ?from_kind=building&from_building=Hancock
 *   Outdoor (from MaristRoute state set by sidebar clicks / right-click menu):
 *     ?from_lon=...&from_lat=...
 *
 * Indoor wins on each side (server does the same). Anything set via
 * MaristIndoor.setSide fires through `mmap:indoor-changed`, which we
 * listen for to re-request.
 */
(function () {
  const ROUTE_SOURCE = 'mm-route';
  const ROUTE_CASING_LAYER = 'mm-route-casing';
  const ROUTE_LINE_LAYER = 'mm-route-line';
  const ROUTE_ENDPOINTS_SOURCE = 'mm-route-endpoints';
  const ROUTE_ENDPOINTS_LAYER = 'mm-route-endpoints-layer';

  const state = {
    from: null,     // { lon, lat, label } — outdoor point only
    to: null,
    route: null,
    inflight: null,
  };

  let _map = null;

  function ensureLayers(map) {
    if (!map.getSource(ROUTE_SOURCE)) {
      map.addSource(ROUTE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getSource(ROUTE_ENDPOINTS_SOURCE)) {
      map.addSource(ROUTE_ENDPOINTS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer(ROUTE_CASING_LAYER)) {
      map.addLayer({
        id: ROUTE_CASING_LAYER, type: 'line', source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 19, 11],
          'line-opacity': 0.9,
        },
      });
    }
    if (!map.getLayer(ROUTE_LINE_LAYER)) {
      map.addLayer({
        id: ROUTE_LINE_LAYER, type: 'line', source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1a73e8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 19, 7],
        },
      });
    }
    if (!map.getLayer(ROUTE_ENDPOINTS_LAYER)) {
      map.addLayer({
        id: ROUTE_ENDPOINTS_LAYER, type: 'circle', source: ROUTE_ENDPOINTS_SOURCE,
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match', ['get', 'role'],
            'from', '#34a853', 'to', '#ea4335',
            '#1a73e8',
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
  }

  // Green start / red end dots come from the ROUTE's first/last trackpoint
  // rather than state.from/state.to, so indoor-only routes get endpoint
  // dots too. Falls back to the outdoor state points when no route has
  // been computed yet (e.g. a single endpoint has been set).
  function endpointsFeatureCollection() {
    const features = [];
    const pts = state.route && state.route.trackpoints;
    if (pts && pts.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pts[0] },
        properties: { role: 'from' },
      });
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pts[pts.length - 1] },
        properties: { role: 'to' },
      });
    } else {
      if (state.from) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [state.from.lon, state.from.lat] },
          properties: { role: 'from' },
        });
      }
      if (state.to) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [state.to.lon, state.to.lat] },
          properties: { role: 'to' },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  // ---- connector / door markers ---------------------------------------
  //
  // For every step along the route that involves a physical transition
  // (entering a building, going up stairs, using an elevator), we drop a
  // maplibregl.Marker at the step's location. Markers are DOM elements
  // so we can use the SVGs from MaristIndoor.icons verbatim without
  // having to rasterize them for a symbol layer.
  //
  // Why Markers instead of a symbol layer: routes are short (a handful
  // of connectors at most), setup is trivial, and the icons stay crisp
  // at any zoom since they're real DOM. The downside — no collision /
  // fade-by-zoom — doesn't matter here.

  const connectorMarkers = [];

  function clearConnectorMarkers() {
    while (connectorMarkers.length) {
      const m = connectorMarkers.pop();
      m.remove();
    }
  }

  /** Should this step get a map marker? Excludes steps whose location
   * would overlap the green/red endpoint dots (exit_room at start,
   * arrive at end) and duplicates of change_floor (exit_connector
   * shares the connector's coordinates). */
  function stepWarrantsMapMarker(step, isFirstStep, isLastStep) {
    if (isFirstStep) return false;         // overlaps start dot
    if (isLastStep) return false;          // overlaps end dot
    if (step.kind === 'exit_connector') return false; // shares pt w/ change_floor
    if (step.kind === 'exit_room') return false;      // shares room point; rare
    switch (step.kind) {
      case 'change_floor':
      case 'enter_building':
      case 'exit_building':
        return true;
      default:
        return false;
    }
  }

  function addConnectorMarkers() {
    clearConnectorMarkers();
    if (!_map) return;
    const route = state.route;
    if (!route || !Array.isArray(route.phases)) return;
    const indoor = window.MaristIndoor;
    if (!indoor || !indoor.icons) return;

    // Flatten steps with a running first/last marker so the renderer
    // knows when to skip endpoints.
    const allSteps = [];
    for (const phase of route.phases) {
      for (const step of (phase.steps || [])) allSteps.push(step);
    }
    allSteps.forEach((step, i) => {
      const isFirst = i === 0;
      const isLast = i === allSteps.length - 1;
      if (!stepWarrantsMapMarker(step, isFirst, isLast)) return;
      const pt = (step.polyline && step.polyline[0]) || null;
      if (!pt || !Array.isArray(pt) || pt.length < 2) return;
      const iconName = indoor.iconNameForStep(step);
      if (!iconName) return;

      const el = document.createElement('div');
      el.className = `mm-route-marker mm-route-marker--${iconName}`;
      el.innerHTML = indoor.icons[iconName](22);
      el.title = step.text || iconName;

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(pt)
        .addTo(_map);
      connectorMarkers.push(marker);
    });
  }

  function renderMap() {
    if (!_map) return;
    ensureLayers(_map);
    const endpoints = _map.getSource(ROUTE_ENDPOINTS_SOURCE);
    if (endpoints) endpoints.setData(endpointsFeatureCollection());
    const routeSrc = _map.getSource(ROUTE_SOURCE);
    if (routeSrc) {
      if (state.route && state.route.feature) {
        routeSrc.setData({
          type: 'FeatureCollection',
          features: [state.route.feature],
        });
      } else {
        routeSrc.setData({ type: 'FeatureCollection', features: [] });
      }
    }
    addConnectorMarkers();
  }

  function fitRoute() {
    if (!_map) return;
    const pts = state.route && state.route.trackpoints;
    if (!pts || pts.length < 2) return;
    let [minLon, minLat] = pts[0];
    let [maxLon, maxLat] = pts[0];
    for (const [lon, lat] of pts) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    _map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: 80, maxZoom: 19, duration: 600,
    });
  }

  function emitChange(extra) {
    document.dispatchEvent(new CustomEvent('mmap:route-changed', {
      detail: {
        from: state.from && { ...state.from },
        to: state.to && { ...state.to },
        route: state.route && { ...state.route },
        ...(extra || {}),
      },
    }));
    if (window.MaristIndoor && typeof window.MaristIndoor.renderSteps === 'function') {
      window.MaristIndoor.renderSteps(state.route);
    }
  }

  function indoorSnapshot() {
    if (window.MaristIndoor && typeof window.MaristIndoor.snapshot === 'function') {
      return window.MaristIndoor.snapshot();
    }
    return { from: null, to: null, preferElevator: false };
  }

  function haveEnoughEndpoints() {
    const indoor = indoorSnapshot();
    return !!(state.from || indoor.from) && !!(state.to || indoor.to);
  }

  // Turn an indoor endpoint payload into query params. The server's
  // `_resolve_endpoint` knows these kinds; adding a new kind means adding
  // one case both here and there.
  function appendIndoorParams(params, prefix, endpoint, label) {
    if (!endpoint) return;
    const ep = endpoint.endpoint || endpoint; // accept either shape
    params.set(`${prefix}_kind`, ep.kind);
    if (ep.building) params.set(`${prefix}_building`, ep.building);
    if (ep.room) params.set(`${prefix}_room`, ep.room);
    if (ep.name) params.set(`${prefix}_name`, ep.name);
    if (label) params.set(`${prefix}_label`, label);
  }

  function buildRouteParams() {
    const indoor = indoorSnapshot();
    const params = new URLSearchParams();

    if (indoor.from) {
      appendIndoorParams(params, 'from', indoor.from.endpoint, indoor.from.label);
    } else if (state.from) {
      params.set('from_lon', state.from.lon);
      params.set('from_lat', state.from.lat);
      if (state.from.label) params.set('from_label', state.from.label);
    }

    if (indoor.to) {
      appendIndoorParams(params, 'to', indoor.to.endpoint, indoor.to.label);
    } else if (state.to) {
      params.set('to_lon', state.to.lon);
      params.set('to_lat', state.to.lat);
      if (state.to.label) params.set('to_label', state.to.label);
    }

    if (indoor.preferElevator) params.set('prefer_elevator', '1');
    return params;
  }

  async function recomputeRoute() {
    if (!haveEnoughEndpoints()) {
      state.route = null;
      renderMap();
      emitChange({ status: 'idle' });
      return;
    }
    if (state.inflight) state.inflight.abort();
    const ctrl = new AbortController();
    state.inflight = ctrl;
    emitChange({ status: 'loading' });
    try {
      const params = buildRouteParams();
      const res = await fetch(`/api/route?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = `routing failed (${res.status})`;
        try {
          const body = await res.json();
          if (body && body.description) msg = body.description;
        } catch (_ignored) { /* not json */ }
        throw new Error(msg);
      }
      state.route = await res.json();
      renderMap();
      fitRoute();
      emitChange({ status: 'ready' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[routing]', err);
      state.route = null;
      renderMap();
      emitChange({ status: 'error', error: err.message || String(err) });
    } finally {
      if (state.inflight === ctrl) state.inflight = null;
    }
  }

  function normalizePoint(pt) {
    if (!pt) return null;
    const lon = Number(pt.lon), lat = Number(pt.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return { lon, lat, label: pt.label || null };
  }

  const api = {
    setStart(pt) {
      state.from = normalizePoint(pt);
      renderMap();
      recomputeRoute();
    },
    setEnd(pt) {
      state.to = normalizePoint(pt);
      renderMap();
      recomputeRoute();
    },
    swap() {
      const indoor = indoorSnapshot();
      if (!state.from && !state.to && !indoor.from && !indoor.to) return;
      [state.from, state.to] = [state.to, state.from];
      if (window.MaristIndoor && typeof window.MaristIndoor.swap === 'function') {
        window.MaristIndoor.swap();
      } else {
        recomputeRoute();
      }
      renderMap();
    },
    clear() {
      state.from = null;
      state.to = null;
      state.route = null;
      if (state.inflight) state.inflight.abort();
      if (window.MaristIndoor) {
        window.MaristIndoor.setSide('from', null);
        window.MaristIndoor.setSide('to', null);
      }
      renderMap();
      emitChange({ status: 'idle' });
    },
    exportGpx() {
      if (!haveEnoughEndpoints()) return;
      const params = buildRouteParams();
      window.location.href = `/api/route.gpx?${params.toString()}`;
    },
    get snapshot() {
      return {
        from: state.from && { ...state.from },
        to: state.to && { ...state.to },
        route: state.route && { ...state.route },
      };
    },
  };

  window.MaristRoute = api;

  document.addEventListener('mmap:indoor-changed', () => recomputeRoute());

  // ---- right-click context menu ---------------------------------------
  const menu = document.createElement('div');
  menu.className = 'map-context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="set-from">Directions from here</button>
    <button type="button" role="menuitem" data-action="set-to">Directions to here</button>
  `;
  document.body.appendChild(menu);

  let menuAt = null;

  function hideMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuAt = null;
  }

  function showMenu(clientX, clientY, lngLat, buildingName) {
    menuAt = { lon: lngLat.lng, lat: lngLat.lat, label: buildingName || null };
    menu.hidden = false;
    const margin = 4;
    const { innerWidth, innerHeight } = window;
    const rect = menu.getBoundingClientRect();
    let x = clientX + margin, y = clientY + margin;
    if (x + rect.width > innerWidth) x = clientX - rect.width - margin;
    if (y + rect.height > innerHeight) y = clientY - rect.height - margin;
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
  }

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !menuAt) return;
    const pt = { lon: menuAt.lon, lat: menuAt.lat, label: menuAt.label };
    if (btn.dataset.action === 'set-from') api.setStart(pt);
    else if (btn.dataset.action === 'set-to') api.setEnd(pt);
    hideMenu();
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  window.addEventListener('resize', hideMenu);
  window.addEventListener('scroll', hideMenu, true);

  const mmap = window.MaristMap;
  if (!mmap || !mmap.ready) {
    console.warn('[routing] MaristMap not found; routing disabled');
    return;
  }

  mmap.ready.then((map) => {
    _map = map;
    ensureLayers(map);
    renderMap();

    map.on('contextmenu', (e) => {
      e.preventDefault();
      let label = null;
      try {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['buildings'] });
        if (hits && hits.length) {
          const p = hits[0].properties || {};
          label = p.name || p['addr:housename'] || p['addr:housenumber'] || null;
        }
      } catch (_ignored) { /* layer may not exist yet */ }
      showMenu(e.originalEvent.clientX, e.originalEvent.clientY, e.lngLat, label);
    });
    map.on('movestart', hideMenu);
    map.on('zoomstart', hideMenu);
    map.on('click', hideMenu);
  });
})();
