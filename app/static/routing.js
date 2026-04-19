/* Routing engine (client half).
 *
 * Owns:
 *  - The `window.MaristRoute` API used by the sidebar (search.js) to set
 *    endpoints, swap, clear, and export GPX.
 *  - The MapLibre source/layers that render the computed route as a
 *    white-cased blue line plus two endpoint dots.
 *  - Calls to /api/route and /api/route.gpx.
 *
 * Deliberately owns no sidebar DOM. Whenever state changes, we dispatch
 * `mmap:route-changed` on `document` with the current {from, to, route}
 * snapshot. The sidebar listens for that event to reflect inputs, the
 * summary line, and the Export GPX button state.
 *
 * Waits for `MaristMap.ready` before touching the map.
 */
(function () {
  const ROUTE_SOURCE = 'mm-route';
  const ROUTE_CASING_LAYER = 'mm-route-casing';
  const ROUTE_LINE_LAYER = 'mm-route-line';
  const ROUTE_ENDPOINTS_SOURCE = 'mm-route-endpoints';
  const ROUTE_ENDPOINTS_LAYER = 'mm-route-endpoints-layer';

  const state = {
    from: null,    // { lon, lat, label }
    to: null,      // { lon, lat, label }
    route: null,   // server response from /api/route
    inflight: null, // AbortController for the current /api/route call
  };

  let _map = null;

  // ---- map layers -------------------------------------------------------

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
        id: ROUTE_CASING_LAYER,
        type: 'line',
        source: ROUTE_SOURCE,
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
        id: ROUTE_LINE_LAYER,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1a73e8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 19, 7],
        },
      });
    }
    if (!map.getLayer(ROUTE_ENDPOINTS_LAYER)) {
      map.addLayer({
        id: ROUTE_ENDPOINTS_LAYER,
        type: 'circle',
        source: ROUTE_ENDPOINTS_SOURCE,
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match',
            ['get', 'role'],
            'from', '#34a853',
            'to',   '#ea4335',
            /* other */ '#1a73e8',
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
  }

  function endpointsFeatureCollection() {
    const features = [];
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
    return { type: 'FeatureCollection', features };
  }

  function renderMap() {
    if (!_map) return;
    ensureLayers(_map);
    const endpoints = _map.getSource(ROUTE_ENDPOINTS_SOURCE);
    if (endpoints) endpoints.setData(endpointsFeatureCollection());

    const routeSrc = _map.getSource(ROUTE_SOURCE);
    if (!routeSrc) return;
    if (state.route && state.route.feature) {
      routeSrc.setData({
        type: 'FeatureCollection',
        features: [state.route.feature],
      });
    } else {
      routeSrc.setData({ type: 'FeatureCollection', features: [] });
    }
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
      padding: 80,
      maxZoom: 19,
      duration: 600,
    });
  }

  // ---- state sync + routing call ---------------------------------------

  function emitChange(extra) {
    document.dispatchEvent(new CustomEvent('mmap:route-changed', {
      detail: {
        from: state.from && { ...state.from },
        to: state.to && { ...state.to },
        route: state.route && { ...state.route },
        ...(extra || {}),
      },
    }));
  }

  async function recomputeRoute() {
    if (!state.from || !state.to) {
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
      const params = new URLSearchParams({
        from_lon: state.from.lon,
        from_lat: state.from.lat,
        to_lon: state.to.lon,
        to_lat: state.to.lat,
      });
      if (state.from.label) params.set('from_label', state.from.label);
      if (state.to.label) params.set('to_label', state.to.label);
      const res = await fetch(`/api/route?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = `routing failed (${res.status})`;
        try {
          const body = await res.json();
          if (body && body.description) msg = body.description;
        } catch (_ignored) { /* body not json */ }
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
    const lon = Number(pt.lon);
    const lat = Number(pt.lat);
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
      if (!(state.from && state.to)) return;
      [state.from, state.to] = [state.to, state.from];
      renderMap();
      recomputeRoute();
    },
    clear() {
      state.from = null;
      state.to = null;
      state.route = null;
      if (state.inflight) state.inflight.abort();
      renderMap();
      emitChange({ status: 'idle' });
    },
    exportGpx() {
      if (!(state.from && state.to)) return;
      const params = new URLSearchParams({
        from_lon: state.from.lon,
        from_lat: state.from.lat,
        to_lon: state.to.lon,
        to_lat: state.to.lat,
      });
      if (state.from.label) params.set('from_label', state.from.label);
      if (state.to.label) params.set('to_label', state.to.label);
      // Let the browser handle the download via the server's
      // Content-Disposition header.
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

  // ---- right-click context menu ----------------------------------------
  //
  // A secondary way to set endpoints. Primary UX lives in the sidebar
  // (search.js), but right-click-on-map-to-set-waypoint is a natural
  // affordance borrowed from Google Maps. Picking an item here calls the
  // same MaristRoute API, and search.js listens to `mmap:route-changed`
  // to flip the sidebar into directions mode so the user sees the
  // synchronized state immediately.
  //
  // Closing rules:
  //  - any click outside the menu,
  //  - Escape,
  //  - map interaction (pan / zoom / left-click),
  //  - window resize.
  //
  // The element uses `hidden` for visibility; style.css has a matching
  // `.map-context-menu[hidden] { display: none }` that beats the
  // `display: flex` default — see note in style.css.

  const menu = document.createElement('div');
  menu.className = 'map-context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="set-from">Directions from here</button>
    <button type="button" role="menuitem" data-action="set-to">Directions to here</button>
  `;
  document.body.appendChild(menu);

  /** Current click location + any building detected under it. */
  let menuAt = null;

  function hideMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuAt = null;
  }

  function showMenu(clientX, clientY, lngLat, buildingName) {
    menuAt = {
      lon: lngLat.lng,
      lat: lngLat.lat,
      label: buildingName || null,
    };
    menu.hidden = false;
    // Position with a nudge so the cursor is inside the menu, and flip
    // sides when we'd otherwise overflow the viewport.
    const margin = 4;
    const { innerWidth, innerHeight } = window;
    const rect = menu.getBoundingClientRect();
    let x = clientX + margin;
    let y = clientY + margin;
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

  // ---- map wiring -------------------------------------------------------

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
      // If the right-click landed on a building polygon, pick up its
      // name (or a sensible fallback) so the directions label is
      // useful rather than a bare lat/lon.
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
