/* Routing engine (client half).
 *
 * Owns:
 *  - The `window.MaristRoute` API used by the sidebar (search.js) to set
 *    endpoints, swap, clear, and export GPX.
 *  - The MapLibre source/layers that render the computed route as a
 *    white-cased blue line plus two endpoint dots.
 *  - Calls to /api/route and /api/route.gpx.
 *  - A Z-assignment pass that promotes the flat route polyline into a
 *    stack of altitude-tagged segments (one per floor) and hands them
 *    to MaristRoute3D for 3D rendering when the map is tilted.
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

  // ---- 3D altitude config ---------------------------------------------
  //
  // Mental model: floor 1 (the ground floor) sits at z=0, same as the
  // outdoor ground plane. Floor N sits at (N-1) * FLOOR_HEIGHT_M. Floor
  // 0 (basement) is below ground at -FLOOR_HEIGHT_M. This keeps the
  // route flat through indoor-outdoor-indoor transitions at ground-floor
  // entrances — no weird pops at doors. Altitude changes only happen at
  // stairwell/elevator connectors, and at the rare basement entrance.
  const FLOOR_HEIGHT_M = 2.75;
  const GROUND_ALT_M = 0;

  function altForFloor(floor) {
    if (floor === null || floor === undefined) return GROUND_ALT_M;
    const n = Number(floor);
    if (!Number.isFinite(n)) return GROUND_ALT_M;
    // Floor 1 = ground = z=0; floor 2 = 2.75m; floor 0 (basement) = -2.75m.
    return (n - 1) * FLOOR_HEIGHT_M;
  }

  const state = {
    from: null,    // { lon, lat, label }
    to: null,      // { lon, lat, label }
    route: null,   // server response from /api/route
    inflight: null, // AbortController for the current /api/route call
    in3d: false,   // mirrors map.js's pitch-based 3D toggle
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


  const connectorMarkers = [];

  function clearConnectorMarkers() {
    while (connectorMarkers.length) {
      const m = connectorMarkers.pop();
      m.remove();
    }
  }

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

  // ---- Z-assignment pass ----------------------------------------------
  //
  // Walks the route's phases and produces a structure that MaristRoute3D
  // can consume directly. Each `segment` is a polyline of [lon, lat, zM]
  // triples. We emit separate segments at connector transitions so each
  // leg is on a single floor and the change-floor point shows as a
  // crisp instantaneous vertical (the L-shape).
  //
  // Output shape (matches route3d.js setRoute contract):
  //   {
  //     segments: [{ coords: [[lon,lat,z], ...] }, ...],
  //     endpoints: { start: [lon,lat,z], end: [lon,lat,z] }
  //   }
  //
  // Rules (all locked in the handoff):
  //   - indoor phase on a single floor => polyline at altForFloor(from_floor)
  //   - indoor phase crossing floors   => split at the change_floor step;
  //     emit leg1 at from_floor, an L-shape at the connector point, and
  //     leg2 at to_floor
  //   - outdoor phase                  => polyline at ground (0 m)
  //   - bridge phase (zero-length)     => inherits the *entering* side's
  //     from_floor via a zero-length vertical join
  //   - indoor<->outdoor transitions   => instantaneous vertical snap
  //     (handled by consecutive segments meeting at an entrance point)
  function buildAltitudePolylines(route) {
    if (!route || !Array.isArray(route.phases)) return null;
    const segments = [];

    // Push a polyline at a constant altitude. Skips degenerate 0/1-point
    // inputs (Line2 crashes on <2 verts).
    const pushConstAlt = (polyline, altM) => {
      if (!Array.isArray(polyline) || polyline.length < 2) return;
      const coords = [];
      for (const p of polyline) {
        if (!Array.isArray(p) || p.length < 2) continue;
        coords.push([Number(p[0]), Number(p[1]), altM]);
      }
      if (coords.length >= 2) segments.push({ coords });
    };

    // Instantaneous vertical jump: two verts at the same (lon,lat) so
    // Line2 renders a clean vertical with no diagonal interpolation.
    const pushVerticalJump = (pt, fromZ, toZ) => {
      if (!pt || !Array.isArray(pt) || pt.length < 2) return;
      if (fromZ === toZ) return;
      segments.push({
        coords: [
          [Number(pt[0]), Number(pt[1]), fromZ],
          [Number(pt[0]), Number(pt[1]), toZ],
        ],
      });
    };

    // --- Pass 1: compute each phase's altitude profile ---
    //
    // Every non-skip phase ends up with { startZ, endZ } describing what
    // altitude the route is at when entering and leaving that phase.
    //
    // Indoor (non-bridge) phases: read from_floor / to_floor directly.
    // Outdoor + bridge phases: mark as "pending", resolved in the next
    // pass by looking at neighbouring indoor phases. Outdoor sits at
    // whatever floor the adjacent entrances are on (floor 1 = z=0 in
    // almost every case), so that entrance transitions don't produce
    // jarring vertical jumps — the route stays flat through the door.
    // The only places altitude visibly changes are stairwell/elevator
    // connectors and (rarely) basement-level outdoor entrances.
    const profiles = route.phases.map((phase) => {
      if (!phase || phase.error) return { kind: 'skip' };
      if (phase.kind === 'outdoor') {
        return { kind: 'outdoor' }; // startZ / endZ resolved next
      }
      if (phase.kind !== 'indoor') return { kind: 'skip' };

      const steps = Array.isArray(phase.steps) ? phase.steps : [];
      const isBridge = steps.length === 1 && steps[0] && steps[0].kind === 'bridge';
      if (isBridge) {
        return { kind: 'bridge' }; // startZ / endZ resolved next
      }
      return {
        kind: 'indoor',
        startZ: altForFloor(phase.from_floor),
        endZ: altForFloor(phase.to_floor),
      };
    });

    // Resolve outdoor + bridge altitudes from neighbours. These share
    // the same inheritance rule: look at the previous indoor phase's
    // endZ and the next indoor phase's startZ.
    const prevResolvedEndZ = (idx) => {
      for (let j = idx - 1; j >= 0; j--) {
        const p = profiles[j];
        if (p.kind === 'indoor') return p.endZ;
        if ((p.kind === 'outdoor' || p.kind === 'bridge')
            && p.endZ !== undefined) return p.endZ;
      }
      return null;
    };
    const nextResolvedStartZ = (idx) => {
      for (let j = idx + 1; j < profiles.length; j++) {
        const p = profiles[j];
        if (p.kind === 'indoor') return p.startZ;
      }
      return null;
    };
    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      if (p.kind !== 'bridge' && p.kind !== 'outdoor') continue;
      let sz = prevResolvedEndZ(i);
      let ez = nextResolvedStartZ(i);
      if (sz === null && ez === null) { sz = GROUND_ALT_M; ez = GROUND_ALT_M; }
      else if (sz === null) sz = ez;
      else if (ez === null) ez = sz;
      p.startZ = sz;
      p.endZ = ez;
    }

    // --- Pass 2: emit segments ---
    for (let i = 0; i < route.phases.length; i++) {
      const phase = route.phases[i];
      const profile = profiles[i];
      if (!phase || !profile || profile.kind === 'skip') continue;

      if (profile.kind === 'outdoor') {
        // Outdoor polyline sits at the altitude of the entrances it
        // connects (usually floor 1 = z=0). If the two ends somehow
        // differ (e.g. basement entrance on one side), we split the
        // outdoor polyline half-and-half for v1 — good enough given
        // entrances at weird floors are vanishingly rare in the data.
        if (profile.startZ === profile.endZ) {
          pushConstAlt(phase.polyline, profile.startZ);
        } else {
          const poly = phase.polyline || [];
          if (poly.length >= 2) {
            const mid = Math.floor(poly.length / 2);
            pushConstAlt(poly.slice(0, mid + 1), profile.startZ);
            pushVerticalJump(poly[mid], profile.startZ, profile.endZ);
            pushConstAlt(poly.slice(mid), profile.endZ);
          }
        }
        continue;
      }

      if (profile.kind === 'bridge') {
        // A bridge has exactly two points: A (entering side, e.g. Rotunda
        // Midrise Entrance) and B (exiting side, e.g. Midrise Rotunda
        // Entrance). Each side has its OWN floor in its home building
        // (Rotunda calls this floor 1, Midrise calls it floor 3). We
        // draw point A at startZ, make the vertical transition at B
        // (since B is the one that needs to match the next phase's floor),
        // and leave point B at endZ for the next phase to pick up.
        //
        //    A@startZ ----- B@startZ
        //                   |
        //                   B@endZ  (vertical at B)
        //
        // If startZ == endZ the vertical jump is a no-op.
        const poly = phase.polyline || [];
        if (poly.length >= 2) {
          const A = poly[0];
          const B = poly[poly.length - 1];
          // Horizontal across the bridge at the entering-side altitude.
          pushConstAlt([A, B], profile.startZ);
          // Vertical at B to match the exiting side's altitude.
          pushVerticalJump(B, profile.startZ, profile.endZ);
        }
        continue;
      }

      // profile.kind === 'indoor' (real indoor traversal, not a bridge)

      const steps = Array.isArray(phase.steps) ? phase.steps : [];
      const fromZ = profile.startZ;
      const toZ = profile.endZ;

      // Single-floor indoor phase is trivial.
      if (fromZ === toZ) {
        pushConstAlt(phase.polyline, fromZ);
        continue;
      }

      // Cross-floor indoor phase. The rule you want:
      //   walk in at fromZ up to the stair, jump vertically AT the
      //   stair, walk out at toZ.
      //
      // The phase's step list always contains exactly one `change_floor`
      // step between the walk_to_connector and exit_connector steps. We
      // split the step list at change_floor, gather each half's polyline
      // points, and emit:
      //   leg1 (everything before change_floor) at fromZ
      //   vertical jump at the connector
      //   leg2 (everything after change_floor) at toZ
      //
      // Step polylines overlap at step boundaries, so we dedupe adjacent
      // duplicate (lon,lat) pairs while gathering.
      const leg1 = [];
      const leg2 = [];
      let connectorPt = null;
      let passedConnector = false;

      const pushUnique = (bucket, pt) => {
        if (!Array.isArray(pt) || pt.length < 2) return;
        const last = bucket[bucket.length - 1];
        if (last && last[0] === pt[0] && last[1] === pt[1]) return;
        bucket.push(pt);
      };

      for (const step of steps) {
        if (!step) continue;
        const sp = Array.isArray(step.polyline) ? step.polyline : [];
        if (step.kind === 'change_floor') {
          connectorPt = sp[0] || null;
          passedConnector = true;
          continue; // the jump is emitted below, not as a bucket push
        }
        const bucket = passedConnector ? leg2 : leg1;
        for (const p of sp) pushUnique(bucket, p);
      }

      // Defensive fallback: if we somehow didn't see a change_floor step,
      // draw the whole thing at fromZ rather than emit nothing.
      if (!connectorPt) {
        pushConstAlt(phase.polyline, fromZ);
        continue;
      }

      // Guarantee leg1 terminates at connectorPt and leg2 starts at it,
      // so the three pieces (leg1, vertical, leg2) join cleanly in
      // (lon,lat) space — only the z changes at the stair.
      const last1 = leg1[leg1.length - 1];
      if (!last1 || last1[0] !== connectorPt[0] || last1[1] !== connectorPt[1]) {
        leg1.push(connectorPt);
      }
      const first2 = leg2[0];
      if (!first2 || first2[0] !== connectorPt[0] || first2[1] !== connectorPt[1]) {
        leg2.unshift(connectorPt);
      }

      pushConstAlt(leg1, fromZ);
      pushVerticalJump(connectorPt, fromZ, toZ);
      pushConstAlt(leg2, toZ);
    }

    // --- Pass 3: stitch indoor↔outdoor transitions ---
    //
    // At a building entrance, the indoor phase ends at floor-1 altitude
    // (≈2.75 m) while the adjoining outdoor phase is at ground (0 m). If
    // we leave a gap, the Three.js scene shows two disconnected lines
    // with a hole at the door. Walk consecutive segment endpoints in
    // order and inject an instantaneous vertical jump at every (lon,lat)
    // match that has a z mismatch. This also catches Hancock-side and
    // Rotunda-side entrance transitions without needing any special case
    // logic for each; we just look at geometry.
    const stitched = [];
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        const prev = segments[i - 1].coords;
        const curr = segments[i].coords;
        const prevEnd = prev[prev.length - 1];
        const currStart = curr[0];
        const sameXY = (
          Math.abs(prevEnd[0] - currStart[0]) < 1e-9
          && Math.abs(prevEnd[1] - currStart[1]) < 1e-9
        );
        const zGap = Math.abs(prevEnd[2] - currStart[2]);
        if (sameXY && zGap > 1e-6) {
          stitched.push({
            coords: [
              [prevEnd[0], prevEnd[1], prevEnd[2]],
              [currStart[0], currStart[1], currStart[2]],
            ],
          });
        }
      }
      stitched.push(segments[i]);
    }
    segments.length = 0;
    for (const s of stitched) segments.push(s);

    // Endpoints: sphere positions come from the first/last meaningful
    // vertex we emitted. We pull these straight from the segments list
    // rather than from route.trackpoints because trackpoints is flat
    // (no altitude).
    let startPt = null;
    let endPt = null;
    if (segments.length) {
      const first = segments[0].coords[0];
      const lastSeg = segments[segments.length - 1].coords;
      const lastVtx = lastSeg[lastSeg.length - 1];
      startPt = [first[0], first[1], first[2]];
      endPt = [lastVtx[0], lastVtx[1], lastVtx[2]];
    }
    return { segments, endpoints: { start: startPt, end: endPt } };
  }

  // ---- flat/3D visibility toggle --------------------------------------

  function applyRouteVisibility() {
    if (!_map) return;
    const show2d = !state.in3d;
    // Flat layers: show only when NOT in 3D
    const setVis = (id, visible) => {
      if (!_map.getLayer(id)) return;
      _map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    };
    setVis(ROUTE_CASING_LAYER, show2d);
    setVis(ROUTE_LINE_LAYER, show2d);
    setVis(ROUTE_ENDPOINTS_LAYER, show2d);
    // 3D layer: opposite
    if (window.MaristRoute3D && typeof window.MaristRoute3D.setVisible === 'function') {
      window.MaristRoute3D.setVisible(!show2d);
    }
  }

  function push3dRoute() {
    if (!window.MaristRoute3D) return;
    if (!state.route) {
      window.MaristRoute3D.clear();
      return;
    }
    const spec = buildAltitudePolylines(state.route);
    if (!spec || !spec.segments.length) {
      window.MaristRoute3D.clear();
      return;
    }
    window.MaristRoute3D.setRoute(spec);
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
    push3dRoute();
    applyRouteVisibility();
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

  function currentGpsPoint() {
    const geo = window.MaristGeo && window.MaristGeo.getLast && window.MaristGeo.getLast();
    if (!geo || !Number.isFinite(geo.lon) || !Number.isFinite(geo.lat)) return null;
    return { lon: geo.lon, lat: geo.lat, label: 'Your location' };
  }

  const api = {
    setStart(pt) {
      state.from = normalizePoint(pt);
      renderMap();
      recomputeRoute();
    },
    setEnd(pt) {
      state.to = normalizePoint(pt);
      // Default the start to live GPS so picking only a destination
      // (e.g. via the search popup's "Directions to here") plans a
      // route immediately without forcing a second pick.
      if (!state.from) {
        const here = currentGpsPoint();
        if (here) state.from = normalizePoint(here);
      }
      renderMap();
      recomputeRoute();
    },
    /** Populate the start with the latest GPS fix if empty. Returns
     *  whether a value was applied. */
    useGpsAsStartIfEmpty() {
      if (state.from) return false;
      const here = currentGpsPoint();
      if (!here) return false;
      state.from = normalizePoint(here);
      renderMap();
      recomputeRoute();
      return true;
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
    /** Apply a route JSON object from POST /api/agent (same shape as /api/route). */
    setRouteFromServer(route) {
      if (!route) return;
      if (state.inflight) state.inflight.abort();
      state.inflight = null;
      state.route = route;
      // Populate state.from / state.to from the route's endpoints so the
      // directions panel inputs reflect what the agent actually routed.
      // The route shape comes from app/trip.py: trackpoints[0] is the
      // start (lon, lat) and trackpoints[-1] is the end. The agent also
      // sends back origin_label / destination_label.
      const pts = route.trackpoints;
      if (Array.isArray(pts) && pts.length >= 2) {
        const [fLon, fLat] = pts[0];
        const [tLon, tLat] = pts[pts.length - 1];
        if (Number.isFinite(fLon) && Number.isFinite(fLat)) {
          state.from = {
            lon: fLon,
            lat: fLat,
            label: route.origin_label || null,
          };
        }
        if (Number.isFinite(tLon) && Number.isFinite(tLat)) {
          state.to = {
            lon: tLon,
            lat: tLat,
            label: route.destination_label || null,
          };
        }
      }
      renderMap();
      fitRoute();
      emitChange({ status: 'ready' });
    },
    /** Called by map.js whenever the pitch crosses the 3D threshold. */
    set3dMode(in3d) {
      const next = !!in3d;
      if (state.in3d === next) return;
      state.in3d = next;
      applyRouteVisibility();
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
