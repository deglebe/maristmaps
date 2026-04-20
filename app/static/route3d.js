/* 3D route rendering via a MapLibre CustomLayerInterface + Three.js.
 *
 * Why this file exists:
 *   MapLibre 4.7.1 doesn't support `line-z-offset` (that shipped in 5.0),
 *   and we don't want to bump the library. So when the camera is tilted
 *   we hide the flat route layer and draw an altitude-aware route into
 *   the same WebGL context via Three.js. Floor N sits at N * 2.75 m
 *   (basement / floor 0 lands at -1.5 m so it reads as below ground).
 *
 * Public API: window.MaristRoute3D
 *   setRoute(routeJson)  install a new route (with altitude-tagged lines)
 *   clear()              remove everything from the scene
 *   setVisible(bool)     show/hide the whole 3D layer
 *
 * routing.js builds an "altitude polyline list" from the server's phase
 * data and feeds it here via setRoute. See _buildAltitudePolylines in
 * routing.js for the Z-assignment pass.
 *
 * Input shape expected by setRoute:
 *   {
 *     segments: [
 *       { coords: [[lon, lat, zMeters], [lon, lat, zMeters], ...] },
 *       ...
 *     ],
 *     endpoints: {
 *       start: [lon, lat, zMeters],
 *       end:   [lon, lat, zMeters],
 *     }
 *   }
 *
 * Mercator math: MapLibre's projection matrix maps Mercator world units
 * (not lon/lat) to clip space. We build vertex positions with
 * MercatorCoordinate.fromLngLat(...) so merc.x, merc.y are in the
 * projection's expected unit system, and scale altitude by
 * merc.meterInMercatorCoordinateUnits() so meters come out right.
 */
(function () {
  const FLOOR_HEIGHT_M = 2.75;
  // Match the flat line's look. Scaled slightly wider than the 2D line
  // so the 3D version reads as the "live" one when pitched.
  const LINE_WIDTH_PX = 6;
  const LINE_COLOR = 0x1a73e8;
  const ENDPOINT_START_COLOR = 0x34a853; // green
  const ENDPOINT_END_COLOR = 0xea4335; // red
  const ENDPOINT_RADIUS_PX = 9; // rough screen-space target

  let _map = null;
  let _gl = null;
  let _scene = null;
  let _camera = null;
  let _renderer = null;
  let _resolution = { w: 1, h: 1 };

  // Per-route resources. We dispose these on clear().
  let _lineObjects = [];
  let _endpointSpheres = [];
  let _pendingRoute = null; // route data waiting for layer onAdd
  let _visible = true;

  // Whether THREE.Line2 / LineGeometry / LineMaterial are available.
  // We look them up lazily at first use because the CDN scripts load
  // after this file on some pages.
  function _lineClasses() {
    if (typeof THREE === "undefined") return null;
    const G = THREE.LineGeometry || window.LineGeometry;
    const M = THREE.LineMaterial || window.LineMaterial;
    const L2 = THREE.Line2 || window.Line2;
    if (!G || !M || !L2) return null;
    return { LineGeometry: G, LineMaterial: M, Line2: L2 };
  }

  // Convert an (lon, lat, altM) triple to Three.js vertex coordinates
  // in MapLibre's Mercator world units. Altitude is passed as an
  // `altitude` arg to fromLngLat (meters), which is the standard idiom.
  function _vertex(lon, lat, altM) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], altM);
    return [m.x, m.y, m.z];
  }

  // Pushes a single 3D polyline into the scene. Returns the Line2 object
  // so clear() can dispose of it properly.
  function _addPolyline(coords3d) {
    if (coords3d.length < 2) return null;
    const cls = _lineClasses();
    if (!cls) {
      console.warn(
        "[route3d] THREE.Line2 classes unavailable — check CDN script tags",
      );
      return null;
    }
    const positions = [];
    for (const [lon, lat, z] of coords3d) {
      const v = _vertex(lon, lat, z);
      positions.push(v[0], v[1], v[2]);
    }
    const geom = new cls.LineGeometry();
    geom.setPositions(positions);

    const mat = new cls.LineMaterial({
      color: LINE_COLOR,
      linewidth: LINE_WIDTH_PX,
      // Line2's LineMaterial needs screen dims to compute pixel width.
      resolution: new THREE.Vector2(_resolution.w, _resolution.h),
      worldUnits: false, // pixel-width, not world-unit
      transparent: false,
      depthTest: false, // draw over extruded buildings
    });

    const line = new cls.Line2(geom, mat);
    line.computeLineDistances();
    _scene.add(line);
    _lineObjects.push({ line, geom, mat });
    return line;
  }

  // Sphere at (lon, lat, altM) in `color`. Size is meant to look roughly
  // like an 8-9px circle at typical zooms (17-18). We don't dynamically
  // rescale with camera distance for v1.
  function _addEndpointSphere(lonLatZ, color) {
    if (typeof THREE === "undefined") return;
    // We size the sphere in meters, picked so it reads as a modest dot
    // on the route at building-scale zooms. 1.2 m radius lines up with
    // the existing 7 px circle radius fairly well at z=18.
    const radiusM = 1.2;
    const geom = new THREE.SphereGeometry(radiusM, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geom, mat);

    // Position the sphere using Mercator world units. The sphere's own
    // "meter" radius needs to be scaled by meterInMercatorCoordinateUnits
    // at the sphere's latitude so geometry size matches the positioning.
    const m = maplibregl.MercatorCoordinate.fromLngLat(
      [lonLatZ[0], lonLatZ[1]],
      lonLatZ[2],
    );
    const scale = m.meterInMercatorCoordinateUnits();
    mesh.position.set(m.x, m.y, m.z);
    mesh.scale.set(scale, scale, scale);
    _scene.add(mesh);
    _endpointSpheres.push({ mesh, geom, mat });
  }

  // Install the pending route into the scene (called once the layer is
  // live and WE have the gl context and scene ready).
  function _applyPendingRoute() {
    if (!_pendingRoute || !_scene) return;
    _clearSceneObjects();
    for (const seg of _pendingRoute.segments || []) {
      if (!seg || !Array.isArray(seg.coords) || seg.coords.length < 2) continue;
      _addPolyline(seg.coords);
    }
    const eps = _pendingRoute.endpoints || {};
    if (eps.start) _addEndpointSphere(eps.start, ENDPOINT_START_COLOR);
    if (eps.end) _addEndpointSphere(eps.end, ENDPOINT_END_COLOR);
    if (_map) _map.triggerRepaint();
  }

  function _clearSceneObjects() {
    if (!_scene) {
      _lineObjects = [];
      _endpointSpheres = [];
      return;
    }
    for (const { line, geom, mat } of _lineObjects) {
      _scene.remove(line);
      if (geom && geom.dispose) geom.dispose();
      if (mat && mat.dispose) mat.dispose();
    }
    _lineObjects = [];
    for (const { mesh, geom, mat } of _endpointSpheres) {
      _scene.remove(mesh);
      if (geom && geom.dispose) geom.dispose();
      if (mat && mat.dispose) mat.dispose();
    }
    _endpointSpheres = [];
  }

  // Update Line2 resolution on resize — without this, pixel widths are
  // wrong after a window resize.
  function _updateResolution() {
    if (!_map) return;
    const canvas = _map.getCanvas();
    _resolution.w = canvas.width;
    _resolution.h = canvas.height;
    for (const { mat } of _lineObjects) {
      if (mat && mat.resolution)
        mat.resolution.set(_resolution.w, _resolution.h);
    }
  }

  // MapLibre CustomLayerInterface object. We implement render/onAdd/onRemove;
  // everything else is optional.
  const customLayer = {
    id: "mm-route-3d",
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      _map = map;
      _gl = gl;

      // Sharing MapLibre's WebGL context means Three needs to be told
      // about it explicitly (don't let it create its own).
      _renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      _renderer.autoClear = false;

      _scene = new THREE.Scene();
      // Plain Camera (not Perspective) — we inject MapLibre's projection
      // matrix directly each frame, no need for FOV/near/far.
      _camera = new THREE.Camera();

      _updateResolution();
      // Track canvas size changes. MapLibre fires 'resize' on its own
      // resize events; our _updateResolution reads the canvas either way.
      map.on("resize", _updateResolution);

      if (_pendingRoute) _applyPendingRoute();
    },

    onRemove() {
      _clearSceneObjects();
      if (_map && _map.off) _map.off("resize", _updateResolution);
      _scene = null;
      _camera = null;
      // Don't dispose _renderer — disposing it can take down the shared gl
      // context that MapLibre owns. Letting it drop out of scope is fine.
      _renderer = null;
      _map = null;
      _gl = null;
    },

    render(gl, matrix) {
      if (!_scene || !_renderer || !_camera) return;
      if (!_visible) return;
      if (_lineObjects.length === 0 && _endpointSpheres.length === 0) return;

      // MapLibre hands us the projection-view matrix for world->clip.
      // Plug it straight into the Three camera.
      const m = new THREE.Matrix4().fromArray(matrix);
      _camera.projectionMatrix = m;

      // The MapLibre custom-layer example resets a handful of GL state
      // knobs after Three renders; without these the next MapLibre
      // layer sometimes renders with the wrong program / VAO bound.
      _renderer.resetState();
      _renderer.render(_scene, _camera);
      // Unbind after Three so MapLibre doesn't inherit our program.
      gl.useProgram(null);
    },
  };

  const api = {
    /** Install a new route. `routeSpec` is the altitude-tagged structure
     *  produced by routing.js's Z-assignment pass. */
    setRoute(routeSpec) {
      _pendingRoute = routeSpec || null;
      if (_scene) _applyPendingRoute();
    },
    clear() {
      _pendingRoute = null;
      _clearSceneObjects();
      if (_map) _map.triggerRepaint();
    },
    setVisible(v) {
      _visible = !!v;
      if (_map) _map.triggerRepaint();
    },
    /** Attach to a MapLibre map. Safe to call before or after map load. */
    attach(map) {
      const addWhenReady = () => {
        if (map.getLayer("mm-route-3d")) return;
        map.addLayer(customLayer);
      };
      if (map.isStyleLoaded && map.isStyleLoaded()) {
        addWhenReady();
      } else {
        map.once("load", addWhenReady);
      }
    },
  };

  window.MaristRoute3D = api;

  // Auto-attach as soon as the MaristMap is ready.
  function _tryAutoAttach() {
    const mmap = window.MaristMap;
    if (!mmap || !mmap.ready) {
      setTimeout(_tryAutoAttach, 50);
      return;
    }
    mmap.ready.then((map) => api.attach(map));
  }
  _tryAutoAttach();
})();
