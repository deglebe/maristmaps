/* Campus map renderer.
 *
 * Pulls its config from the <script id="map-page-config"> JSON blob the
 * server embeds, builds a MapLibre style against Martin's vector tiles,
 * and wires up the shared interactions (popups, hover highlight, 3D
 * tilt toggle, campus-bound clamp).
 *
 * Exposes a tiny global on `window.MaristMap` so other scripts (e.g.
 * search.js) can reach the map once it's ready:
 *
 *   MaristMap.ready.then((map) => map.flyTo(...));
 *
 * and a `mmap:ready` DOM event on `document` for the same purpose.
 */
(function () {
  const cfgEl = document.getElementById("map-page-config");
  if (!cfgEl) {
    console.error("[map] missing #map-page-config element; cannot init map");
    return;
  }
  const cfg = JSON.parse(cfgEl.textContent);
  /**
   * tiles
   *
   * Purpose:
   * Build the Martin XYZ tile URL template for a given PostGIS table name.
   *
   * Args:
   * table - Backend table slug exposed by Martin (e.g. planet_osm_polygon).
   *
   * Returns:
   * Tile URL pattern string with {z}/{x}/{y} placeholders.
   */
  const tiles = (table) => `${cfg.martinBase}/${table}/{z}/{x}/{y}`;

  /* map focused on footpaths */
  const GREEN_LANDUSE = [
    "grass",
    "park",
    "recreation_ground",
    "meadow",
    "forest",
    "cemetery",
    "village_green",
  ];
  const GREEN_LEISURE = [
    "park",
    "garden",
    "pitch",
    "playground",
    "nature_reserve",
    "golf_course",
  ];
  const MAJOR_ROADS = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
  ];
  const MINOR_ROADS = [
    "residential",
    "service",
    "unclassified",
    "living_street",
    "road",
  ];
  const PATH_KINDS = [
    "footway",
    "path",
    "pedestrian",
    "cycleway",
    "track",
    "bridleway",
    "corridor",
  ];
  const STAIR_KINDS = ["steps"];

  /* Basemap palettes — keyed off `data-theme` on <html> so the toggle
   * can swap them at runtime via setPaintProperty. Light is the
   * "google-maps-ish" palette we started with; dark is tuned to the
   * Everforest dark-medium variant (muted, cool, readable on OLED). */
  const PALETTES = {
    light: {
      bg: "#f2efe6",
      green: "#c4dfa2",
      campus: "#ebe5d3",
      paved: "#e4dfd2",
      building: "#d9cfbe",
      buildOutline: "#8a7559",
      water: "#aad3df",
      majorFill: "#fce5a7",
      majorCase: "#d59952",
      minorFill: "#ffffff",
      minorCase: "#b6ad99",
      pathFill: "#b96e30",
      pathCasing: "#ffffff",
      pathStairs: "#8c4a1a",
      buildingHover: "#f6c470",
      poiFill: "#2a5d9f",
      poiStroke: "#ffffff",
    },
    dark: {
      bg: "#2d353b",
      green: "#3c4b40",
      campus: "#343f44",
      paved: "#3d484d",
      building: "#4a545a",
      buildOutline: "#6a7a73",
      water: "#3a515d",
      majorFill: "#58605c",
      majorCase: "#3d484d",
      minorFill: "#475258",
      minorCase: "#3d484d",
      pathFill: "#e69875",
      pathCasing: "#2d353b",
      pathStairs: "#dbbc7f",
      buildingHover: "#dbbc7f",
      poiFill: "#7fbbb3",
      poiStroke: "#2d353b",
    },
  };

  const readTheme = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "light" ? "light" : "dark";
  };

  let C = PALETTES[readTheme()];
  const PATH_COLOR = C.pathFill;
  const PATH_STAIRS = C.pathStairs;

  const style = {
    version: 8,
    sources: {
      osm_polygon: {
        type: "vector",
        tiles: [tiles("planet_osm_polygon")],
        minzoom: 0,
        maxzoom: 16,
      },
      osm_line: {
        type: "vector",
        tiles: [tiles("planet_osm_line")],
        minzoom: 0,
        maxzoom: 16,
      },
      osm_roads: {
        type: "vector",
        tiles: [tiles("planet_osm_roads")],
        minzoom: 0,
        maxzoom: 16,
      },
      osm_point: {
        type: "vector",
        tiles: [tiles("planet_osm_point")],
        minzoom: 0,
        maxzoom: 16,
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.bg } },

      {
        id: "landuse-green",
        type: "fill",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: [
          "any",
          ["in", ["get", "landuse"], ["literal", GREEN_LANDUSE]],
          ["in", ["get", "leisure"], ["literal", GREEN_LEISURE]],
          [
            "in",
            ["get", "natural"],
            ["literal", ["wood", "scrub", "grassland"]],
          ],
        ],
        paint: { "fill-color": C.green, "fill-opacity": 0.9 },
      },
      {
        id: "landuse-campus",
        type: "fill",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: [
          "in",
          ["get", "amenity"],
          ["literal", ["school", "university", "college"]],
        ],
        paint: { "fill-color": C.campus },
      },
      {
        id: "landuse-paved",
        type: "fill",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: [
          "any",
          ["==", ["get", "amenity"], "parking"],
          ["==", ["get", "landuse"], "residential"],
          ["==", ["get", "landuse"], "commercial"],
        ],
        paint: { "fill-color": C.paved },
      },
      {
        id: "water-fill",
        type: "fill",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: [
          "any",
          ["==", ["get", "natural"], "water"],
          ["==", ["get", "waterway"], "riverbank"],
          ["==", ["get", "landuse"], "reservoir"],
        ],
        paint: { "fill-color": C.water },
      },
      {
        id: "waterway",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: [
          "in",
          ["get", "waterway"],
          ["literal", ["river", "stream", "canal", "drain", "ditch"]],
        ],
        paint: {
          "line-color": C.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 18, 3],
        },
      },

      // --- Vehicle roads: OSM-style casing/fill hierarchy ---
      {
        id: "roads-minor-casing",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: ["in", ["get", "highway"], ["literal", MINOR_ROADS]],
        minzoom: 12,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.minorCase,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 18, 9],
        },
      },
      {
        id: "roads-minor",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: ["in", ["get", "highway"], ["literal", MINOR_ROADS]],
        minzoom: 12,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.minorFill,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 18, 7],
        },
      },
      {
        id: "roads-major-casing",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: ["in", ["get", "highway"], ["literal", MAJOR_ROADS]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.majorCase,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 18, 15],
        },
      },
      {
        id: "roads-major",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: ["in", ["get", "highway"], ["literal", MAJOR_ROADS]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.majorFill,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 18, 11],
        },
      },

      // --- Buildings (2D) ---
      // Visible whenever the map is not tilted; the `pitchend` handler below
      // swaps these out for the 3D extrusion layer when you tilt the camera.
      {
        id: "buildings",
        type: "fill",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: ["has", "building"],
        paint: { "fill-color": C.building, "fill-opacity": 1.0 },
      },
      {
        id: "buildings-outline",
        type: "line",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: ["has", "building"],
        paint: {
          "line-color": C.buildOutline,
          "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 20, 1.8],
        },
      },
      // Hover highlight for buildings. Initial filter matches nothing; the
      // `mousemove`/`mouseleave` handlers below call setFilter to point it at
      // the currently-hovered osm_id.
      {
        id: "buildings-hover",
        type: "fill",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: ["==", ["get", "osm_id"], -1],
        paint: { "fill-color": C.buildingHover, "fill-opacity": 0.55 },
      },

      // --- Buildings (3D extrusion, shown only when the camera is tilted) ---
      // Height comes from OSM `height` (meters) when present, else from
      // `building:levels * 3.5`, else a 10 m fallback so every building has
      // some mass. The extrusion layer is hidden at pitch=0 so zoomed-out,
      // straight-down views stay crisp and legible.
      {
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "osm_polygon",
        "source-layer": "planet_osm_polygon",
        filter: ["has", "building"],
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": C.building,
          "fill-extrusion-height": [
            "case",
            ["has", "height"],
            ["to-number", ["get", "height"], 10],
            ["has", "building:levels"],
            ["*", ["to-number", ["get", "building:levels"], 3], 3.5],
            10,
          ],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.92,
          "fill-extrusion-vertical-gradient": true,
        },
      },

      // --- Paths: campus headline, but calmer than before ---
      {
        id: "paths-casing",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: [
          "in",
          ["get", "highway"],
          ["literal", PATH_KINDS.concat(STAIR_KINDS)],
        ],
        minzoom: 12,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.pathCasing,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12,
            1.5,
            15,
            4,
            19,
            9,
          ],
          "line-opacity": 0.95,
        },
      },
      {
        id: "paths",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: ["in", ["get", "highway"], ["literal", PATH_KINDS]],
        minzoom: 12,
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": PATH_COLOR,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12,
            0.8,
            15,
            1.8,
            19,
            4,
          ],
          "line-dasharray": [2, 1.25],
        },
      },
      {
        id: "paths-stairs",
        type: "line",
        source: "osm_line",
        "source-layer": "planet_osm_line",
        filter: ["in", ["get", "highway"], ["literal", STAIR_KINDS]],
        minzoom: 14,
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": PATH_STAIRS,
          "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 19, 6],
          "line-dasharray": [0.6, 0.5],
        },
      },

      // --- POIs ---
      // POI circles are temporarily hidden via `layout.visibility` — the
      // underlying source/filter is kept so turning them back on is a
      // one-line change.
      {
        id: "poi-circles",
        type: "circle",
        source: "osm_point",
        "source-layer": "planet_osm_point",
        layout: { visibility: "none" },
        minzoom: 14,
        filter: [
          "any",
          ["has", "amenity"],
          ["has", "shop"],
          ["has", "tourism"],
          ["has", "leisure"],
          ["has", "office"],
          ["has", "healthcare"],
        ],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            14,
            2.5,
            18,
            5,
          ],
          "circle-color": C.poiFill,
          "circle-stroke-color": C.poiStroke,
          "circle-stroke-width": 1.2,
        },
      },

      // --- Labels ---
      // Text / symbol layers are intentionally omitted until we self-host a
      // glyph set; see the `glyphs:` comment above. Popups on click still
      // surface every tagged attribute, so we don't lose discoverability.
    ],
  };

  // Campus is only ~1 km across, so clamp both the zoom range and the
  // pannable area. Without this you can zoom out until the data is a dot or
  // pan across the Hudson into blank territory the PBF doesn't cover.
  const CAMPUS_BOUNDS = [
    [cfg.center[0] - 0.014, cfg.center[1] - 0.01], // SW  (~1.15 km W, ~1.10 km S)
    [cfg.center[0] + 0.014, cfg.center[1] + 0.01], // NE
  ];

  const map = new maplibregl.Map({
    container: "map",
    attributionControl: false,
    antialias: true, // smoother edges on extruded building walls
    style,
    center: cfg.center,
    zoom: cfg.zoom,
    minZoom: 14,
    maxZoom: 20,
    maxPitch: 75,
    maxBounds: CAMPUS_BOUNDS,
  });
  map.addControl(
    new maplibregl.NavigationControl({
      visualizePitch: true,
      showCompass: true,
    }),
    "top-right",
  );
  map.addControl(
    new maplibregl.ScaleControl({ unit: "imperial" }),
    "bottom-left",
  );

  map.once("load", () => {
    map.resize();
  });

  // ---------- theme swap --------------------------------------------------
  //
  // theme.js fires `mmap:theme-change` on document whenever the user flips
  // the toggle. Each layer that was painted with a palette color has an
  // entry in COLORED_LAYERS so we can repaint without reloading the whole
  // style (which would drop runtime-added sources / hover filters).
  const COLORED_LAYERS = [
    ["bg",                 "background-color",      "bg"],
    ["landuse-green",      "fill-color",            "green"],
    ["landuse-campus",     "fill-color",            "campus"],
    ["landuse-paved",      "fill-color",            "paved"],
    ["water-fill",         "fill-color",            "water"],
    ["waterway",           "line-color",            "water"],
    ["roads-minor-casing", "line-color",            "minorCase"],
    ["roads-minor",        "line-color",            "minorFill"],
    ["roads-major-casing", "line-color",            "majorCase"],
    ["roads-major",        "line-color",            "majorFill"],
    ["buildings",          "fill-color",            "building"],
    ["buildings-outline",  "line-color",            "buildOutline"],
    ["buildings-hover",    "fill-color",            "buildingHover"],
    ["buildings-3d",       "fill-extrusion-color",  "building"],
    ["paths-casing",       "line-color",            "pathCasing"],
    ["paths",              "line-color",            "pathFill"],
    ["paths-stairs",       "line-color",            "pathStairs"],
    ["poi-circles",        "circle-color",          "poiFill"],
    ["poi-circles",        "circle-stroke-color",   "poiStroke"],
  ];

  const applyTheme = (name) => {
    const next = PALETTES[name] || PALETTES.dark;
    C = next;
    for (const [layerId, prop, key] of COLORED_LAYERS) {
      if (!map.getLayer(layerId)) continue;
      try {
        map.setPaintProperty(layerId, prop, next[key]);
      } catch (err) {
        console.warn("[map] setPaintProperty failed", layerId, prop, err);
      }
    }
  };

  const onThemeChange = (ev) => {
    const theme = ev && ev.detail && ev.detail.theme;
    applyTheme(theme || readTheme());
  };
  document.addEventListener("mmap:theme-change", onThemeChange);
  // In case the style loads after the theme was already flipped by an
  // earlier page-load event, apply once on `load` too.
  map.on("load", () => applyTheme(readTheme()));

  // Tilt affordance: right-click + drag (or ctrl-drag) rotates/pitches the
  // camera, same as Google Maps. Double-click the compass to reset north/up.
  // Once pitch > PITCH_3D_THRESHOLD the 2D building fill/outline swap out for
  // the extruded variant; below that threshold we go back to the flat view
  // because top-down 3D boxes just look like chunky outlines.
  const PITCH_3D_THRESHOLD = 15;
  let in3d = false;
  /**
   * update3dLayers
   *
   * Purpose:
   * Switch between flat building fill/outline and 3D extrusion based on pitch.
   *
   * Args:
   * None (reads map pitch via closure).
   *
   * Returns:
   * Nothing.
   */

   const update3dLayers = () => {
    const shouldBe3d = map.getPitch() > PITCH_3D_THRESHOLD;
    if (shouldBe3d === in3d) return;
    in3d = shouldBe3d;
    const set = (id, visible) =>
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    set("buildings", !in3d);
    set("buildings-outline", !in3d);
    set("buildings-3d", in3d);
    if (toggleBtn) toggleBtn.classList.toggle("active", in3d);
    // Notify the routing layer so it can swap flat MapLibre line for the
    // Three.js altitude-aware variant. Safe before MaristRoute is ready:
    // MaristRoute.set3dMode no-ops when state is already in sync, and
    // routing.js's own mmap.ready handler will pick up the current map
    // pitch on its first renderMap() call.
    if (window.MaristRoute && typeof window.MaristRoute.set3dMode === "function") {
      window.MaristRoute.set3dMode(in3d);
    }
  };



  map.on("pitch", update3dLayers);
  map.on("load", update3dLayers);

  // A simple custom control that flips between flat and tilted views. Drops
  // in next to the navigation control so it reads as part of the toolset.
  /**
   * PitchToggle
   *
   * Purpose:
   * MapLibre IControl that toggles camera pitch between ~0° and ~55° for 3D.
   *
   * Args:
   * None (class constructor invoked with `new`).
   *
   * Returns:
   * Control instance (MapLibre calls onAdd/onRemove).
   */
  class PitchToggle {
    /**
     * onAdd
     *
     * Purpose:
     * Mount the "3D" button next to stock navigation controls.
     *
     * Args:
     * m - maplibregl.Map instance.
     *
     * Returns:
     * HTMLElement container for the control.
     */
    onAdd(m) {
      this._map = m;
      this._container = document.createElement("div");
      this._container.className =
        "maplibregl-ctrl maplibregl-ctrl-group pitch-toggle";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = "Toggle 3D view";
      btn.setAttribute("aria-label", "Toggle 3D view");
      btn.textContent = "3D";
      btn.addEventListener("click", () => {
        const currentPitch = m.getPitch();
        m.easeTo({
          pitch: currentPitch > PITCH_3D_THRESHOLD ? 0 : 55,
          bearing: currentPitch > PITCH_3D_THRESHOLD ? 0 : m.getBearing(),
          duration: 500,
        });
      });
      this._container.appendChild(btn);
      this._btn = btn;
      return this._container;
    }
    /**
     * onRemove
     *
     * Purpose:
     * Remove the control DOM when MapLibre disposes the control.
     *
     * Args:
     * None.
     *
     * Returns:
     * Nothing.
     */
    onRemove() {
      this._container.remove();
      this._map = undefined;
    }
  }
  const pitchToggle = new PitchToggle();
  map.addControl(pitchToggle, "top-right");
  const toggleBtn = pitchToggle._btn;

  const CLICKABLE_LAYERS = ["buildings", "paths", "paths-stairs"];
  /**
   * escapeHtml
   *
   * Purpose:
   * Escape HTML special characters for safe insertion into popup markup.
   *
   * Args:
   * s - Value coerced to string.
   *
   * Returns:
   * Escaped string.
   */
  const escapeHtml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  /**
   * parseHstore
   *
   * Purpose:
   * Parse PostgreSQL hstore text from osm2pgsql into a plain key/value object.
   *
   * Args:
   * raw - Hstore string, plain object passthrough, or null/empty.
   *
   * Returns:
   * Object mapping tag keys to string values (empty object on failure).
   */
  const parseHstore = (raw) => {
    const out = {};
    if (raw == null || raw === "") return out;
    if (typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
    if (typeof raw !== "string") return out;
    const s = raw.trim();
    if (!s || s === "{}") return out;
    const unesc = (t) => t.replace(/\\(.)/g, "$1");
    const re =
      /"((?:[^"\\]|\\.)*)"\s*=>\s*(?:"((?:[^"\\]|\\.)*)"|NULL)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const key = unesc(m[1]);
      if (m[2] !== undefined) out[key] = unesc(m[2]);
    }
    return out;
  };

  /**
   * mergeTagsIntoProps
   *
   * Purpose:
   * Merge hstore `tags` with MVT feature properties; columns override tags.
   *
   * Args:
   * p - Raw GeoJSON properties from a vector tile feature.
   *
   * Returns:
   * Combined property object for popup rendering.
   */
  const mergeTagsIntoProps = (p) => {
    const fromTags = parseHstore(p.tags);
    const merged = { ...fromTags };
    for (const key of Object.keys(p)) {
      if (key === "tags") continue;
      const v = p[key];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        merged[key] = v;
      }
    }
    return merged;
  };

  // Only show curated columns — not the raw hstore `tags` blob or internal ids.
  const GENERIC_TAG_ORDER = [
    "name",
    "amenity",
    "shop",
    "tourism",
    "leisure",
    "office",
    "healthcare",
    "highway",
    "surface",
    "bicycle",
    "foot",
    "wheelchair",
    "oneway",
    "access",
    "landuse",
    "natural",
    "waterway",
    "man_made",
    "barrier",
    "ref",
  ];
  const HIDDEN_KEYS = new Set(["osm_id", "way_area", "z_order", "tags"]);

  const KEY_LABELS = {
    name: "Name",
    amenity: "Amenity",
    shop: "Shop",
    tourism: "Tourism",
    leisure: "Leisure",
    office: "Office",
    healthcare: "Healthcare",
    highway: "Kind",
    surface: "Surface",
    bicycle: "Bicycle",
    foot: "Pedestrian",
    wheelchair: "Wheelchair",
    oneway: "One-way",
    access: "Access",
    landuse: "Land use",
    natural: "Natural",
    waterway: "Waterway",
    man_made: "Structure",
    barrier: "Barrier",
    ref: "Reference",
  };

  /**
   * humanizeUnderscore
   *
   * Purpose:
   * Turn OSM underscore tokens into Title Case words for display.
   *
   * Args:
   * s - Raw tag value string.
   *
   * Returns:
   * Human-readable string.
   */
  const humanizeUnderscore = (s) =>
    String(s)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());

  /**
   * labelForKey
   *
   * Purpose:
   * Choose a table header label for an OSM property key.
   *
   * Args:
   * k - Property key (e.g. addr:street, amenity).
   *
   * Returns:
   * Display label string.
   */
  const labelForKey = (k) => {
    if (KEY_LABELS[k]) return KEY_LABELS[k];
    return k.includes(":")
      ? k.replace(/:/g, " · ")
      : humanizeUnderscore(k);
  };

  /**
   * formatAddressBlock
   *
   * Purpose:
   * Build a multi-line postal address string from addr:* tags.
   *
   * Args:
   * p - Merged properties including addr:* keys.
   *
   * Returns:
   * Newline-separated address, or empty string if nothing usable.
   */
  const formatAddressBlock = (p) => {
    const lines = [];
    if (p["addr:housename"]) lines.push(String(p["addr:housename"]).trim());
    const num = p["addr:housenumber"];
    const street = p["addr:street"] || p["addr:place"];
    let streetLine = [num, street].filter(Boolean).join(" ").trim();
    if (!streetLine && num) streetLine = String(num).trim();
    if (streetLine) lines.push(streetLine);
    const cityLine = [
      [p["addr:city"], p["addr:state"]].filter(Boolean).join(", "),
      p["addr:postcode"],
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (cityLine) lines.push(cityLine);
    if (p["addr:country"]) lines.push(String(p["addr:country"]).trim());
    return lines.join("\n");
  };

  /**
   * isBareUnknownBuilding
   *
   * Purpose:
   * Detect generic `building=yes` footprints with no useful title or detail tags.
   *
   * Args:
   * p - Merged building properties.
   *
   * Returns:
   * True if the popup should show only the title with no detail table.
   */
  const isBareUnknownBuilding = (p) => {
    if (formatAddressBlock(p)) return false;
    if (p.name && String(p.name).trim()) return false;
    if (p["addr:housename"] && String(p["addr:housename"]).trim()) return false;
    if (p.amenity) return false;
    if (p.shop) return false;
    if (p.brand) return false;
    if (p.operator) return false;
    if (p.building && p.building !== "yes") return false;
    if (p.phone || p["contact:phone"]) return false;
    if (p.website || p["contact:website"]) return false;
    if (p.opening_hours) return false;
    if (p.wheelchair || p["toilets:wheelchair"] || p["entrance:wheelchair"])
      return false;
    if (p.access) return false;
    if (p.internet_access) return false;
    if (p.ref) return false;
    const b = p.building != null ? String(p.building) : "yes";
    return b === "yes";
  };

  /**
   * buildingPopupTitle
   *
   * Purpose:
   * Pick the bold popup title for a building from name, address, or amenity tags.
   *
   * Args:
   * p - Merged building properties (after overrides).
   *
   * Returns:
   * Short title string.
   */
  const buildingPopupTitle = (p) => {
    if (isBareUnknownBuilding(p)) return "Building";
    if (p.name && String(p.name).trim()) return String(p.name).trim();
    if (p["addr:housename"] && String(p["addr:housename"]).trim())
      return String(p["addr:housename"]).trim();
    if (p.brand && String(p.brand).trim()) return String(p.brand).trim();
    if (p.amenity) return humanizeUnderscore(p.amenity);
    if (p.shop) return humanizeUnderscore(p.shop);
    if (p.building && p.building !== "yes") return humanizeUnderscore(p.building);
    return "Building";
  };

  /**
   * websiteHref
   *
   * Purpose:
   * Normalize a website/tag value into an absolute http(s) URL for href=.
   *
   * Args:
   * v - Raw URL or hostname string.
   *
   * Returns:
   * URL string, or empty string if input is empty after trim.
   */
  const websiteHref = (v) => {
    const t = String(v).trim();
    if (!t) return "";
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  };

  /**
   * buildingTableRows
   *
   * Purpose:
   * Build HTML <tr> rows for building popup detail table (non-bare buildings).
   *
   * Args:
   * p - Merged building properties.
   *
   * Returns:
   * Concatenated table row HTML, or empty string for bare unknown buildings.
   */
  const buildingTableRows = (p) => {
    if (isBareUnknownBuilding(p)) return "";

    const rows = [];
    /**
     * pushRow
     *
     * Purpose:
     * Append one attribute row to the in-progress table HTML.
     *
     * Args:
     * label - Table header text.
     * value - Cell value (skipped if blank).
     * multiline - If true, use popup-addr white-space styling.
     *
     * Returns:
     * Nothing.
     */
    const pushRow = (label, value, multiline = false) => {
      if (value === undefined || value === null || String(value).trim() === "")
        return;
      const cls = multiline ? ' class="popup-addr"' : "";
      rows.push(
        `<tr><th>${escapeHtml(label)}</th><td${cls}>${escapeHtml(String(value))}</td></tr>`,
      );
    };

    const addr = formatAddressBlock(p);
    if (addr) {
      rows.push(
        `<tr><th>Address</th><td class="popup-addr">${escapeHtml(addr)}</td></tr>`,
      );
    }

    if (p.building && String(p.building).trim() && p.building !== "yes") {
      pushRow("Building type", humanizeUnderscore(p.building));
    }
    if (p.amenity) pushRow("Amenity", humanizeUnderscore(p.amenity));
    if (p.shop) pushRow("Shop", humanizeUnderscore(p.shop));
    if (p.brand) pushRow("Brand", String(p.brand));
    pushRow("Operator", p.operator);
    pushRow("Floors", p["building:levels"]);
    pushRow("Hours", p.opening_hours);

    const phone = p.phone || p["contact:phone"];
    pushRow("Phone", phone);

    const webRaw = p.website || p["contact:website"];
    if (webRaw) {
      const w = String(webRaw).trim();
      if (w) {
        const href = websiteHref(w);
        rows.push(
          `<tr><th>Website</th><td><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w)}</a></td></tr>`,
        );
      }
    }

    const accLines = [];
    if (p.wheelchair)
      accLines.push(`Building / paths: ${humanizeUnderscore(p.wheelchair)}`);
    if (p["toilets:wheelchair"])
      accLines.push(`Restrooms: ${humanizeUnderscore(p["toilets:wheelchair"])}`);
    if (p["entrance:wheelchair"])
      accLines.push(`Entrance: ${humanizeUnderscore(p["entrance:wheelchair"])}`);
    if (accLines.length) pushRow("Accessibility", accLines.join("\n"), true);

    if (p.access) pushRow("General access", humanizeUnderscore(p.access));
    if (p.internet_access)
      pushRow("Internet", humanizeUnderscore(p.internet_access));

    pushRow("Reference", p.ref);

    return rows.join("");
  };

  /**
   * genericAttributeRows
   *
   * Purpose:
   * Build attribute table rows for non-building features in fixed key order.
   *
   * Args:
   * props - Merged feature properties.
   * preferredOrder - Key order (GENERIC_TAG_ORDER).
   *
   * Returns:
   * Concatenated <tr> HTML for non-empty keys in order.
   */
  const genericAttributeRows = (props, preferredOrder) => {
    const rows = [];
    for (const k of preferredOrder) {
      if (HIDDEN_KEYS.has(k)) continue;
      const v = props[k];
      if (v === undefined || v === null || String(v).trim() === "") continue;
      const label = labelForKey(k);
      let display = String(v);
      if (k === "highway" || k === "amenity") display = humanizeUnderscore(display);
      rows.push(
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(display)}</td></tr>`,
      );
    }
    return rows.join("");
  };

  /**
   * popupHtml
   *
   * Purpose:
   * Build full popup HTML for a clicked vector feature (building vs other layers).
   *
   * Args:
   * feature - MapLibre feature with properties and layer.
   *
   * Returns:
   * HTML string passed to Popup#setHTML.
   */
  const directionsButtonHtml = () => (
    `<div class="popup-actions">` +
    `  <button type="button" class="popup-action popup-action--to" data-action="directions">Directions</button>` +
    `</div>`
  );

  const popupHtml = (feature) => {
    const raw = feature.properties || {};
    const isBuilding = feature.layer && feature.layer.id === "buildings";
    const overrides = cfg.buildingNameOverrides || {};
    let p = mergeTagsIntoProps(raw);
    if (isBuilding && raw.osm_id != null) {
      const custom = overrides[String(raw.osm_id)];
      if (custom && String(custom).trim()) {
        p = { ...p, name: String(custom).trim() };
      }
    }

    if (isBuilding) {
      const title = buildingPopupTitle(p);
      const inner = buildingTableRows(p);
      const body = inner
        ? `<table class="attrs">${inner}</table>`
        : '<div class="tag">No extra details</div>';
      return {
        title,
        html: `<strong>${escapeHtml(title)}</strong>${body}${directionsButtonHtml()}`,
      };
    }

    const title =
      p.name ||
      p["addr:housename"] ||
      p["addr:housenumber"] ||
      p.brand ||
      p.building ||
      p.amenity ||
      p.shop ||
      p.highway ||
      "Feature";

    const rows = genericAttributeRows(p, GENERIC_TAG_ORDER);
    const body = rows
      ? `<table class="attrs">${rows}</table>`
      : '<div class="tag">No tagged attributes</div>';
    return {
      title: String(title),
      html: `<strong>${escapeHtml(title)}</strong>${body}${directionsButtonHtml()}`,
    };
  };

  map.on("click", (e) => {
    const features = map.queryRenderedFeatures(e.point, {
      layers: CLICKABLE_LAYERS,
    });
    if (!features.length) return;
    const clicked = features[0];
    const oid = clicked.properties && clicked.properties.osm_id;
    if (oid != null) {
      console.log("[map] osm_id:", oid, "| layer:", clicked.layer && clicked.layer.id);
    }
    const { title, html } = popupHtml(clicked);
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: "22rem",
    })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map);
    const root = popup.getElement();
    if (root) {
      root.addEventListener("click", (ev) => {
        const btn = ev.target.closest('button[data-action="directions"]');
        if (!btn) return;
        ev.preventDefault();
        const route = window.MaristRoute;
        if (!route) return;
        route.setEnd({
          lon: e.lngLat.lng,
          lat: e.lngLat.lat,
          label: title || null,
        });
        popup.remove();
      });
    }
  });

  CLICKABLE_LAYERS.forEach((id) => {
    map.on("mouseenter", id, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", id, () => {
      map.getCanvas().style.cursor = "";
    });
  });

  // Drive the building-highlight layer by rewriting its filter on mousemove.
  const NO_MATCH_FILTER = ["==", ["get", "osm_id"], -1];
  let hoveredOsmId = null;
  map.on("mousemove", "buildings", (e) => {
    if (!e.features.length) return;
    const id = e.features[0].properties && e.features[0].properties.osm_id;
    if (id === hoveredOsmId) return;
    hoveredOsmId = id;
    if (id !== undefined && id !== null) {
      map.setFilter("buildings-hover", ["==", ["get", "osm_id"], id]);
    }
  });
  map.on("mouseleave", "buildings", () => {
    hoveredOsmId = null;
    map.setFilter("buildings-hover", NO_MATCH_FILTER);
  });

  map.on("error", (e) => {
    if (e && e.error)
      console.warn("[map]", e.error.message || e.error, e.source || "");
  });

  // One-shot diagnostic: after the first render, report how many building
  // features MapLibre actually has in view.
  map.once("idle", () => {
    const n = map.queryRenderedFeatures({ layers: ["buildings"] }).length;
    console.log(`[map] buildings in viewport after first render: ${n}`);
    if (n === 0) {
      console.warn(
        "[map] no building features. Check `curl -s " +
          cfg.martinBase +
          "/catalog` and make sure planet_osm_polygon " +
          "is listed; then `docker compose restart martin` if not.",
      );
    }
  });

  window.addEventListener("resize", () => map.resize());

  // Publish the ready handle. Resolves once MapLibre's first 'load' fires,
  // which is when styles, sources, and layers are safe to query.
  const ready = new Promise((resolve) => {
    if (map.loaded && map.loaded()) {
      resolve(map);
    } else {
      map.once("load", () => resolve(map));
    }
  });
  window.MaristMap = Object.freeze({ map, ready, popupHtml, escapeHtml });
  document.dispatchEvent(new CustomEvent("mmap:ready", { detail: { map } }));
})();
