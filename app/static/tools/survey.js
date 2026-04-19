/* GeoLog — mobile GPS surveying tool.
 *
 * Rewritten from Leaflet + Esri satellite to MapLibre + Martin OSM
 * vector tiles so it matches the rest of the app (map.js, csv_viz).
 * Keeps every prior feature:
 *   - live GPS watch + accuracy ring
 *   - draggable pin (tap map or drag to place)
 *   - three log modes: room / connector (stairs/elevator) / entrance
 *   - per-field lock with "Edit" button to reopen
 *   - closest-entrance preview for rooms
 *   - session name, notes toggle, CSV export
 *
 * CSV output now matches csv_viz's full DEFAULT_HEADERS schema exactly,
 * so a file exported here loads into tools/edit.html without touching
 * the db/add_closest.py recompute pass.
 *
 * The Flask route that serves this file injects a `<script
 * id="geolog-config">` JSON blob with the Martin URL and campus center;
 * see app/templates/tools/survey.html.
 */
(function () {

var $ = function (s) { return document.querySelector(s); };
var app = document.getElementById("app");
var statusEl = document.getElementById("gps-status");
var titleEl = document.getElementById("hdr-title");

// ── Config injected by the Flask template ────────────────────────
var CFG = (function () {
  var defaults = {
    martinBase: "http://127.0.0.1:3000",
    center: [-73.93446921913481, 41.72233476143977],
    zoom: 18,
  };
  var el = document.getElementById("geolog-config");
  if (!el) return defaults;
  try {
    var parsed = JSON.parse(el.textContent);
    return {
      martinBase: (parsed.martinBase || defaults.martinBase).replace(/\/+$/, ""),
      center: Array.isArray(parsed.center) && parsed.center.length === 2
        ? parsed.center : defaults.center,
      zoom: Number.isFinite(parsed.zoom) ? parsed.zoom : defaults.zoom,
    };
  } catch (_) {
    return defaults;
  }
})();

// ── Map state ────────────────────────────────────────────────────
var map = null;
var pinMarker = null;       // draggable pin for current selection
var loggedMarkers = [];     // MapLibre markers for already-logged entries
var mapReady = false;

// GPS accuracy circle — rendered as a GeoJSON fill layer so it scales
// correctly with zoom (unlike CSS-sized screen-pixel circles).
var GPS_SRC = "geolog-gps-circle";
var GPS_FILL = "geolog-gps-fill";
var GPS_LINE = "geolog-gps-outline";

var ORIENTATIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

var S = {
  screen: "idle",
  sessionName: "",
  entries: [],
  watchId: null,
  gpsPos: null,                 // raw GPS position
  pinPos: null,                 // pin (what gets logged) — {lat, lng}
  gps: "off",
  bldg: "",
  floor: "",
  /** Connector mode only: stair/elevator serves this span of floors */
  floorFrom: "",
  floorTo: "",
  bldgLock: false,
  floorLock: false,
  /** @type {"room"|"connector"|"entrance"} */
  logMode: "room",
  connectorKind: "stairs",      // stairs | elevator
  entranceOrientation: "N",
};

// ── GPS ──────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) {
    S.gps = "error";
    render();
    return;
  }
  S.gps = "waiting";
  S.watchId = navigator.geolocation.watchPosition(
    function (p) {
      S.gpsPos = {
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        acc: p.coords.accuracy ? Math.round(p.coords.accuracy) : null,
      };
      S.gps = "on";
      // Only auto-set pin on first fix
      if (!S.pinPos) {
        S.pinPos = { lat: S.gpsPos.lat, lng: S.gpsPos.lng };
        if (map) {
          map.setCenter([S.pinPos.lng, S.pinPos.lat]);
          map.setZoom(Math.max(map.getZoom(), 18));
          updatePin();
          updateGPSCircle();
        }
      } else {
        updateGPSCircle();
      }
      updateCoordsBar();
      updateStatus();
    },
    function () {
      S.gps = "error";
      updateStatus();
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
  );
  updateStatus();
}

function stopGPS() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
  S.gpsPos = null;
  S.pinPos = null;
  S.gps = "off";
}

function updateStatus() {
  var gl = {
    off: "gps off",
    waiting: "acquiring...",
    on: "gps on",
    error: "no gps",
  };
  statusEl.textContent = gl[S.gps];
  statusEl.className =
    "gps-status" +
    (S.gps === "on" ? " on" : "") +
    (S.gps === "error" ? " err" : "");
}

// ── Helpers ──────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function csvEsc(s) {
  s = String(s);
  return s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}
function fmtT(d) {
  return d.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function fmtD(d) {
  return d.toLocaleDateString([], {
    month: "short", day: "numeric", year: "numeric",
  });
}
function fm(n) { return n != null ? n.toFixed(6) : "\u2014"; }

function haversineM(a, b) {
  var R = 6371000;
  var p1 = (a.lat * Math.PI) / 180;
  var p2 = (b.lat * Math.PI) / 180;
  var dp = ((b.lat - a.lat) * Math.PI) / 180;
  var dl = ((b.lng - a.lng) * Math.PI) / 180;
  var x =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Entrances in session for same building; pos is room pin for distance. */
function findClosestEntrance(bldg, pos) {
  var b = String(bldg || "").trim();
  if (!b || !pos) return null;
  var best = null;
  var bestD = Infinity;
  S.entries.forEach(function (e) {
    if ((e.kind || "room") !== "entrance") return;
    if (String(e.bldg || "").trim() !== b) return;
    var d = haversineM(pos, { lat: e.lat, lng: e.lng });
    if (d < bestD) {
      bestD = d;
      var name = String(e.room || "Entrance").trim() || "Entrance";
      var o = e.orientation ? String(e.orientation) : "";
      best = {
        label: o ? name + " (" + o + ")" : name,
        name: name,
        distM: d,
      };
    }
  });
  return best;
}

/** Closest connector in session matching subtype within same building. */
function findClosestConnector(bldg, pos, subtype) {
  var b = String(bldg || "").trim();
  if (!b || !pos) return null;
  var best = null;
  var bestD = Infinity;
  S.entries.forEach(function (e) {
    if ((e.kind || "room") !== "connector") return;
    if (String(e.bldg || "").trim() !== b) return;
    if ((e.connectorKind || "stairs") !== subtype) return;
    var d = haversineM(pos, { lat: e.lat, lng: e.lng });
    if (d < bestD) {
      bestD = d;
      best = {
        name: String(e.room || "").trim()
          || (subtype === "elevator" ? "Elevator" : "Stairs"),
        distM: d,
      };
    }
  });
  return best;
}

function formatDistM(d) {
  if (d == null || !isFinite(d)) return "";
  if (d < 1000) return Math.round(d) + " m";
  return (d / 1000).toFixed(2) + " km";
}

function entryKindLabel(e) {
  var k = e.kind || "room";
  if (k === "entrance") return "Entrance";
  if (k === "connector") {
    return e.connectorKind === "elevator" ? "Elevator" : "Stairs";
  }
  return "Room";
}

function formatFloorRange(from, to) {
  var a = String(from || "").trim();
  var b = String(to || "").trim();
  if (!a && !b) return "\u2014";
  if (a && !b) return a;
  if (!a && b) return b;
  if (a === b) return a;
  return a + "\u2013" + b;
}

function connectorFloorsLabel(e) {
  var fa = String(e.floorFrom || "").trim();
  var fb = String(e.floorTo || "").trim();
  if (fa || fb) return formatFloorRange(e.floorFrom, e.floorTo);
  return String(e.floor || "\u2014");
}

function orientationOptionsHTML(selected) {
  return ORIENTATIONS.map(function (o) {
    return (
      '<option value="' + esc(o) + '"' +
      (o === selected ? " selected" : "") + ">" + esc(o) + "</option>"
    );
  }).join("");
}

/** One entry row for the list (shared by renderActive + renderList). */
function entryListItemHTML(e, n) {
  var kind = e.kind || "room";
  var nameLine = "";
  var extraLine = "";

  if (kind === "room") {
    nameLine = esc(e.bldg) + " \u00b7 " + esc(e.floor) + " \u00b7 " + esc(e.room);
    var extras = [];
    if (e.closestEntrance) extras.push("Entrance: " + esc(e.closestEntrance));
    if (e.closestStair) extras.push("Stair: " + esc(e.closestStair));
    if (e.closestElevator) extras.push("Elev: " + esc(e.closestElevator));
    if (extras.length) {
      extraLine = '<div class="entry-extra">' + extras.join(" \u00b7 ") + "</div>";
    }
  } else if (kind === "entrance") {
    nameLine =
      esc(e.bldg) + " \u00b7 " + esc(e.floor) +
      " \u00b7 Entrance \u00b7 " + esc(e.room || "\u2014");
    if (e.orientation) {
      extraLine = '<div class="entry-extra">Building face: ' + esc(e.orientation) + "</div>";
    }
  } else {
    var ck = e.connectorKind === "elevator" ? "Elevator" : "Stairs";
    var lab = String(e.room || "").trim();
    nameLine =
      esc(e.bldg) + " \u00b7 " + esc(connectorFloorsLabel(e)) + " \u00b7 " +
      ck + (lab ? ": " + esc(lab) : "");
    if (e.directionFromConnector) {
      extraLine = '<div class="entry-extra">Direction: ' + esc(e.directionFromConnector) + "</div>";
    }
  }

  return (
    '<div class="entry">' +
    '<div class="entry-top">' +
    '<div class="entry-num">' + n + "</div>" +
    '<div class="entry-body">' +
    '<div class="entry-kind">' + esc(entryKindLabel(e)) + "</div>" +
    '<div class="entry-name">' + nameLine + "</div>" +
    '<div class="entry-sub">' + fm(e.lat) + ", " + fm(e.lng) + "</div>" +
    extraLine +
    "</div>" +
    '<div class="entry-aside">' +
    '<div class="entry-time">' + fmtT(new Date(e.ts)) + "</div>" +
    '<button class="entry-del" data-id="' + e.id + '">delete</button>' +
    "</div>" +
    "</div>" +
    (e.notes ? '<div class="entry-notes">' + esc(e.notes) + "</div>" : "") +
    "</div>"
  );
}

// ── CSV Export ───────────────────────────────────────────────────
//
// Header matches csv_viz.html's DEFAULT_HEADERS exactly so a file
// exported here drops into tools/edit.html without schema surgery.
//
// Columns with no field-time equivalent:
//   Closest entrance (elevator)  — mirrored from Closest entrance at log
//     time (surveyor uses one pin; separate stair-vs-elevator entrance
//     routing is recomputed by db/add_closest.py at import)
//   Direction from connector     — captured for connector entries only
//   Connections                  — hallway graph; always blank here
//     (drawn in csv_viz after the fact, not in the field)

function buildCSV(entries) {
  var sorted = entries.slice().reverse();  // oldest first for stable "#" column
  var hd = [
    "#",
    "Kind",
    "Subtype",
    "Orientation",
    "Closest entrance",
    "Closest entrance (elevator)",
    "Building",
    "Floor",
    "Room",
    "Latitude",
    "Longitude",
    "Notes",
    "Closest stair",
    "Closest elevator",
    "Direction from connector",
    "Connections",
    "Date",
    "Time",
    "Timestamp",
  ];
  var rows = [hd.join(",")];
  sorted.forEach(function (e, i) {
    var d = new Date(e.ts);
    var kind = e.kind || "room";
    var subtype =
      kind === "connector"
        ? (e.connectorKind === "elevator" ? "elevator" : "stairs")
        : "";
    var orient = kind === "entrance" ? String(e.orientation || "") : "";
    var closestEnt = kind === "room" ? String(e.closestEntrance || "").trim() : "";
    var closestEntElev = kind === "room" ? String(e.closestEntrance || "").trim() : "";
    var closestStair = kind === "room" ? String(e.closestStair || "").trim() : "";
    var closestElev = kind === "room" ? String(e.closestElevator || "").trim() : "";
    var dirFrom = kind === "connector" ? String(e.directionFromConnector || "").trim() : "";
    rows.push(
      [
        i + 1,
        csvEsc(kind),
        csvEsc(subtype),
        csvEsc(orient),
        csvEsc(closestEnt),
        csvEsc(closestEntElev),
        csvEsc(e.bldg),
        csvEsc(e.floor),
        csvEsc(e.room),
        e.lat,
        e.lng,
        csvEsc(e.notes || ""),
        csvEsc(closestStair),
        csvEsc(closestElev),
        csvEsc(dirFrom),
        "",                                 // Connections — always empty here
        csvEsc(fmtD(d)),
        fmtT(d),
        e.ts,
      ].join(","),
    );
  });
  return new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
}

function doExport() {
  if (!S.entries.length) return;
  var name = S.sessionName.trim() || "geolog";
  var safe =
    name.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_") || "geolog";
  var a = document.createElement("a");
  a.href = URL.createObjectURL(buildCSV(S.entries));
  a.download = safe + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Map ──────────────────────────────────────────────────────────
//
// Style mirrors the one in csv_viz.html (dark-themed OSM). Labels are
// omitted since Martin doesn't host glyphs — consistent with map.html.

var PATH_KINDS = ["footway","path","pedestrian","cycleway","track","bridleway","corridor"];
var STAIR_KINDS = ["steps"];
var MAJOR_ROADS = ["motorway","trunk","primary","secondary","tertiary",
  "motorway_link","trunk_link","primary_link","secondary_link","tertiary_link"];
var MINOR_ROADS = ["residential","service","unclassified","living_street","road"];
var GREEN_LANDUSE = ["grass","park","recreation_ground","meadow","forest","cemetery","village_green"];
var GREEN_LEISURE = ["park","garden","pitch","playground","nature_reserve","golf_course"];

var C = {
  bg: "#0f0f0f",
  green: "#1e2a1a",
  campus: "#1a1a1a",
  paved: "#242322",
  building: "#2a2622",
  buildOutline: "#463d30",
  water: "#14242b",
  majorFill: "#3a332a",
  majorCase: "#22201c",
  minorFill: "#2a2926",
  minorCase: "#1f1e1c",
  pathFill: "#8a5b2c",
  pathCasing: "#2a2520",
  pathStairs: "#6e4418",
};

function tilesUrl(table) {
  return CFG.martinBase + "/" + table + "/{z}/{x}/{y}";
}

function buildStyle() {
  return {
    version: 8,
    sources: {
      osm_polygon: { type: "vector", tiles: [tilesUrl("planet_osm_polygon")], minzoom: 0, maxzoom: 16 },
      osm_line:    { type: "vector", tiles: [tilesUrl("planet_osm_line")],    minzoom: 0, maxzoom: 16 },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.bg } },
      {
        id: "landuse-green", type: "fill",
        source: "osm_polygon", "source-layer": "planet_osm_polygon",
        filter: ["any",
          ["in", ["get","landuse"], ["literal", GREEN_LANDUSE]],
          ["in", ["get","leisure"], ["literal", GREEN_LEISURE]],
          ["in", ["get","natural"], ["literal", ["wood","scrub","grassland"]]],
        ],
        paint: { "fill-color": C.green, "fill-opacity": 0.9 },
      },
      {
        id: "landuse-campus", type: "fill",
        source: "osm_polygon", "source-layer": "planet_osm_polygon",
        filter: ["in", ["get","amenity"], ["literal", ["school","university","college"]]],
        paint: { "fill-color": C.campus },
      },
      {
        id: "landuse-paved", type: "fill",
        source: "osm_polygon", "source-layer": "planet_osm_polygon",
        filter: ["any",
          ["==", ["get","amenity"], "parking"],
          ["==", ["get","landuse"], "residential"],
          ["==", ["get","landuse"], "commercial"],
        ],
        paint: { "fill-color": C.paved },
      },
      {
        id: "water-fill", type: "fill",
        source: "osm_polygon", "source-layer": "planet_osm_polygon",
        filter: ["any",
          ["==", ["get","natural"], "water"],
          ["==", ["get","waterway"], "riverbank"],
          ["==", ["get","landuse"], "reservoir"],
        ],
        paint: { "fill-color": C.water },
      },
      {
        id: "roads-minor-casing", type: "line",
        source: "osm_line", "source-layer": "planet_osm_line",
        filter: ["in", ["get","highway"], ["literal", MINOR_ROADS]], minzoom: 12,
        layout: { "line-cap":"round", "line-join":"round" },
        paint: { "line-color": C.minorCase,
          "line-width": ["interpolate",["linear"],["zoom"],12,1.2,18,9] },
      },
      {
        id: "roads-minor", type: "line",
        source: "osm_line", "source-layer": "planet_osm_line",
        filter: ["in", ["get","highway"], ["literal", MINOR_ROADS]], minzoom: 12,
        layout: { "line-cap":"round", "line-join":"round" },
        paint: { "line-color": C.minorFill,
          "line-width": ["interpolate",["linear"],["zoom"],12,0.5,18,7] },
      },
      {
        id: "roads-major-casing", type: "line",
        source: "osm_line", "source-layer": "planet_osm_line",
        filter: ["in", ["get","highway"], ["literal", MAJOR_ROADS]],
        layout: { "line-cap":"round", "line-join":"round" },
        paint: { "line-color": C.majorCase,
          "line-width": ["interpolate",["linear"],["zoom"],10,1.2,18,15] },
      },
      {
        id: "roads-major", type: "line",
        source: "osm_line", "source-layer": "planet_osm_line",
        filter: ["in", ["get","highway"], ["literal", MAJOR_ROADS]],
        layout: { "line-cap":"round", "line-join":"round" },
        paint: { "line-color": C.majorFill,
          "line-width": ["interpolate",["linear"],["zoom"],10,0.6,18,11] },
      },
      {
        id: "buildings", type: "fill",
        source: "osm_polygon", "source-layer": "planet_osm_polygon",
        filter: ["has","building"],
        paint: { "fill-color": C.building, "fill-opacity": 1 },
      },
      {
        id: "buildings-outline", type: "line",
        source: "osm_polygon", "source-layer": "planet_osm_polygon",
        filter: ["has","building"],
        paint: { "line-color": C.buildOutline,
          "line-width": ["interpolate",["linear"],["zoom"],14,0.6,20,1.8] },
      },
      {
        id: "paths-casing", type: "line",
        source: "osm_line", "source-layer": "planet_osm_line",
        filter: ["in", ["get","highway"], ["literal", PATH_KINDS.concat(STAIR_KINDS)]],
        minzoom: 12,
        layout: { "line-cap":"round", "line-join":"round" },
        paint: { "line-color": C.pathCasing,
          "line-width": ["interpolate",["linear"],["zoom"],12,1.5,15,4,19,9],
          "line-opacity": 0.95 },
      },
      {
        id: "paths", type: "line",
        source: "osm_line", "source-layer": "planet_osm_line",
        filter: ["in", ["get","highway"], ["literal", PATH_KINDS]], minzoom: 12,
        layout: { "line-cap":"butt", "line-join":"round" },
        paint: { "line-color": C.pathFill,
          "line-width": ["interpolate",["linear"],["zoom"],12,0.8,15,1.8,19,4],
          "line-dasharray": [2, 1.25] },
      },
      {
        id: "paths-stairs", type: "line",
        source: "osm_line", "source-layer": "planet_osm_line",
        filter: ["in", ["get","highway"], ["literal", STAIR_KINDS]], minzoom: 14,
        layout: { "line-cap":"butt", "line-join":"round" },
        paint: { "line-color": C.pathStairs,
          "line-width": ["interpolate",["linear"],["zoom"],14,2,19,6],
          "line-dasharray": [0.6, 0.5] },
      },
    ],
  };
}

// SVG icon factories — identical visuals to the Leaflet divIcons.
function pinIconSVG() {
  return (
    '<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="#e74c3c"/>' +
    '<circle cx="14" cy="14" r="6" fill="#fff"/></svg>'
  );
}

function markerElForEntry(e) {
  var el = document.createElement("div");
  var k = e.kind || "room";
  el.className = "mm-logged mm-logged--" + k;
  if (k === "entrance") {
    el.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16">' +
      '<rect x="2" y="2" width="12" height="12" rx="2" fill="#5a9fff" stroke="#111" stroke-width="1"/></svg>';
  } else if (k === "connector") {
    var elev = e.connectorKind === "elevator";
    el.innerHTML = elev
      ? '<svg width="16" height="16" viewBox="0 0 16 16">' +
        '<rect x="3" y="1" width="10" height="14" rx="1" fill="#6af" stroke="#111" stroke-width="1"/>' +
        '<path d="M8 4v8M6 7l2-2 2 2" stroke="#111" fill="none" stroke-width="1"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16">' +
        '<path d="M8 1L14 14H2L8 1z" fill="#daa520" stroke="#111" stroke-width="1"/></svg>';
  } else {
    el.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 14 14">' +
      '<circle cx="7" cy="7" r="6" fill="#5a5" stroke="#111" stroke-width="2"/></svg>';
  }
  return el;
}

function initMap() {
  var startLng = S.pinPos ? S.pinPos.lng : CFG.center[0];
  var startLat = S.pinPos ? S.pinPos.lat : CFG.center[1];

  map = new maplibregl.Map({
    container: "map",
    style: buildStyle(),
    center: [startLng, startLat],
    zoom: CFG.zoom,
    minZoom: 10,
    maxZoom: 22,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

  map.on("error", function (e) {
    if (e && e.error) console.warn("[geolog]", e.error.message || e.error);
  });

  // Pin marker (draggable) — DOM element + maplibregl.Marker wrapper.
  var pinEl = document.createElement("div");
  pinEl.className = "mm-pin";
  pinEl.innerHTML = pinIconSVG();
  pinMarker = new maplibregl.Marker({
    element: pinEl,
    draggable: true,
    anchor: "bottom",
  }).setLngLat([startLng, startLat]).addTo(map);

  pinMarker.on("dragend", function () {
    var pos = pinMarker.getLngLat();
    S.pinPos = { lat: pos.lat, lng: pos.lng };
    updateCoordsBar();
  });

  // Tap map to move pin
  map.on("click", function (e) {
    S.pinPos = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    pinMarker.setLngLat([e.lngLat.lng, e.lngLat.lat]);
    updateCoordsBar();
  });

  map.on("load", function () {
    mapReady = true;
    ensureGPSCircleLayer();
    updateGPSCircle();
    refreshLoggedMarkers();
    map.resize();
  });
}

function updatePin() {
  if (pinMarker && S.pinPos) {
    pinMarker.setLngLat([S.pinPos.lng, S.pinPos.lat]);
  }
}

function ensureGPSCircleLayer() {
  if (!map || !mapReady) return;
  if (!map.getSource(GPS_SRC)) {
    map.addSource(GPS_SRC, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: GPS_FILL, type: "fill", source: GPS_SRC,
      paint: { "fill-color": "#4a9eff", "fill-opacity": 0.1 },
    });
    map.addLayer({
      id: GPS_LINE, type: "line", source: GPS_SRC,
      paint: { "line-color": "#4a9eff", "line-width": 1, "line-opacity": 0.7 },
    });
  }
}

/** Approximate a circle of `radiusM` meters at (lng,lat) with a 64-gon.
 *
 * Closed-form is fine for the scales and latitudes we care about (campus
 * at ~42°N, tens-of-meters accuracy radius). Not true geodesic but
 * visually indistinguishable at these sizes. */
function circlePolygonCoords(lng, lat, radiusM) {
  var N = 64;
  var R = 6378137;               // earth radius, m
  var mPerLat = (1 / ((Math.PI / 180) * R)) * radiusM;
  var mPerLng = mPerLat / Math.cos((lat * Math.PI) / 180);
  var ring = [];
  for (var i = 0; i <= N; i++) {
    var t = (i / N) * 2 * Math.PI;
    ring.push([lng + mPerLng * Math.cos(t), lat + mPerLat * Math.sin(t)]);
  }
  return [ring];
}

function updateGPSCircle() {
  if (!map || !mapReady || !S.gpsPos) return;
  ensureGPSCircleLayer();
  var src = map.getSource(GPS_SRC);
  if (!src) return;
  var acc = S.gpsPos.acc || 10;
  src.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: circlePolygonCoords(S.gpsPos.lng, S.gpsPos.lat, acc),
      },
      properties: {},
    }],
  });
}

function updateCoordsBar() {
  var el = document.getElementById("coords-bar");
  if (!el || !S.pinPos) return;
  el.innerHTML =
    '<span>LAT <span class="val">' + fm(S.pinPos.lat) + "</span></span>" +
    '<span>LNG <span class="val">' + fm(S.pinPos.lng) + "</span></span>";
  updateClosestPreview();
}

function updateClosestPreview() {
  var el = document.getElementById("closest-preview");
  if (!el) return;
  if (S.logMode !== "room") return;
  if (!S.pinPos || !String(S.bldg || "").trim()) {
    el.textContent = "\u2014";
    el.className = "closest-preview-val";
    return;
  }
  var hit = findClosestEntrance(S.bldg, S.pinPos);
  if (!hit) {
    el.textContent = "No entrances for this building yet";
    el.className = "closest-preview-val muted";
    return;
  }
  el.className = "closest-preview-val";
  el.textContent = hit.label + " \u00b7 " + formatDistM(hit.distM);
}

function logButtonLabel() {
  if (S.logMode === "connector") {
    return S.connectorKind === "elevator" ? "Log elevator" : "Log stairs";
  }
  if (S.logMode === "entrance") return "Log entrance";
  return "Log room";
}

function refreshLoggedMarkers() {
  if (!map || !mapReady) return;
  loggedMarkers.forEach(function (m) { m.remove(); });
  loggedMarkers = [];
  S.entries.forEach(function (e) {
    var el = markerElForEntry(e);
    var m = new maplibregl.Marker({
      element: el,
      anchor: "center",
    }).setLngLat([e.lng, e.lat]).addTo(map);
    loggedMarkers.push(m);
  });
}

function pushMarkerForEntry(entry) {
  if (!map || !mapReady) return;
  var el = markerElForEntry(entry);
  var m = new maplibregl.Marker({
    element: el,
    anchor: "center",
  }).setLngLat([entry.lng, entry.lat]).addTo(map);
  loggedMarkers.push(m);
}

function recenterToGPS() {
  if (!S.gpsPos || !map) return;
  S.pinPos = { lat: S.gpsPos.lat, lng: S.gpsPos.lng };
  pinMarker.setLngLat([S.pinPos.lng, S.pinPos.lat]);
  map.easeTo({
    center: [S.pinPos.lng, S.pinPos.lat],
    zoom: map.getZoom(),
    duration: 400,
  });
  updateCoordsBar();
}

// ── Render ───────────────────────────────────────────────────────
function render() {
  updateStatus();

  if (S.screen === "active" && S.sessionName.trim()) {
    titleEl.innerHTML =
      'GeoLog <span class="session">/ ' + esc(S.sessionName.trim()) + "</span>";
  } else {
    titleEl.textContent = "GeoLog";
  }

  if (S.screen === "idle") {
    if (map) {
      map.remove();
      map = null;
      pinMarker = null;
      mapReady = false;
      loggedMarkers = [];
    }
    renderIdle();
  } else {
    renderActive();
  }
}

function renderIdle() {
  app.innerHTML =
    '<div class="idle">' +
    "<p>Log building rooms with<br>GPS coordinates.</p>" +
    '<input class="session-input" type="text" id="sname" placeholder="Session name (becomes filename)" value="' +
    esc(S.sessionName) + '" />' +
    '<button class="start-btn" id="go">Start Session</button>' +
    (S.entries.length
      ? '<button class="export-prev" id="ep">Export previous (' + S.entries.length + ")</button>"
      : "") +
    "</div>";

  var sn = $("#sname");
  sn.oninput = function () { S.sessionName = sn.value; };
  $("#go").onclick = function () {
    if (!S.sessionName.trim()) {
      sn.focus();
      sn.setAttribute("placeholder", "Give this session a name");
      return;
    }
    S.screen = "active";
    S.entries = [];
    S.bldg = "";
    S.floor = "";
    S.floorFrom = "";
    S.floorTo = "";
    S.bldgLock = false;
    S.floorLock = false;
    S.pinPos = null;
    S.logMode = "room";
    S.connectorKind = "stairs";
    S.entranceOrientation = "N";
    startGPS();
    renderActive();
  };
  var ep = $("#ep");
  if (ep) ep.onclick = doExport;
}

function renderActive() {
  var bL = S.bldgLock, fL = S.floorLock;

  var listHTML = "";
  if (S.entries.length === 0) {
    listHTML = '<div class="empty">Nothing logged yet</div>';
  } else {
    listHTML = S.entries.map(function (e, i) {
      var n = S.entries.length - i;
      return entryListItemHTML(e, n);
    }).join("");
  }

  var modeRoom = S.logMode === "room";
  var modeConn = S.logMode === "connector";
  var modeEnt = S.logMode === "entrance";
  var ckStairs = S.connectorKind === "stairs";
  var ckElev = S.connectorKind === "elevator";

  app.innerHTML =
    '<div class="map-wrap">' +
    '<div id="map"></div>' +
    '<div class="map-hint">Tap map or drag pin to set position</div>' +
    '<button class="recenter-btn" id="recenter">Re-center GPS</button>' +
    "</div>" +
    '<div class="coords-bar" id="coords-bar">' +
    '<span>LAT <span class="val">' + fm(S.pinPos ? S.pinPos.lat : null) + "</span></span>" +
    '<span>LNG <span class="val">' + fm(S.pinPos ? S.pinPos.lng : null) + "</span></span>" +
    "</div>" +
    '<div class="panel">' +
    '<div class="field-group">' +
    '<div class="field-row">' +
    "<label>Bldg</label>" +
    '<input type="text" id="i-bldg" placeholder="Building name" value="' +
    esc(S.bldg) + '" ' + (bL ? 'class="locked" disabled' : "") + " />" +
    (bL ? '<button class="edit-btn" id="e-bldg">Edit</button>' : "") +
    "</div>" +
    (modeConn
      ? '<div class="field-row">' +
        "<label>From floor</label>" +
        '<input type="text" id="i-floor-from" placeholder="e.g. 2" value="' +
        esc(S.floorFrom) + '" ' + (fL ? 'class="locked" disabled' : "") + " />" +
        (fL ? '<button class="edit-btn" id="e-floor">Edit</button>' : "") +
        "</div>" +
        '<div class="field-row">' +
        "<label>To floor</label>" +
        '<input type="text" id="i-floor-to" placeholder="e.g. 5" value="' +
        esc(S.floorTo) + '" ' + (fL ? 'class="locked" disabled' : "") + " />" +
        "</div>"
      : '<div class="field-row">' +
        "<label>Floor</label>" +
        '<input type="text" id="i-floor" placeholder="Floor" value="' +
        esc(S.floor) + '" ' + (fL ? 'class="locked" disabled' : "") + " />" +
        (fL ? '<button class="edit-btn" id="e-floor">Edit</button>' : "") +
        "</div>") +
    "</div>" +
    '<div class="log-mode-row">' +
    '<button type="button" class="log-mode-btn' + (modeRoom ? " active" : "") + '" id="m-room">Room</button>' +
    '<button type="button" class="log-mode-btn' + (modeConn ? " active" : "") + '" id="m-connector">Stairs / Elevator</button>' +
    '<button type="button" class="log-mode-btn' + (modeEnt ? " active" : "") + '" id="m-entrance">Entrance</button>' +
    "</div>" +
    '<div id="block-room" class="log-block' + (modeRoom ? "" : " hidden") + '">' +
    '<div class="room-row room-row-fill">' +
    '<input type="text" id="i-room" placeholder="Room number or name" />' +
    "</div>" +
    '<div class="closest-row">' +
    "<span>Closest entrance</span>" +
    '<span class="closest-preview-val" id="closest-preview">\u2014</span>' +
    "</div>" +
    "</div>" +
    '<div id="block-connector" class="log-block' + (modeConn ? "" : " hidden") + '">' +
    '<div class="connector-kind-row">' +
    '<button type="button" class="ck-btn' + (ckStairs ? " active" : "") + '" id="ck-stairs" data-k="stairs">Stairs</button>' +
    '<button type="button" class="ck-btn' + (ckElev ? " active" : "") + '" id="ck-elev" data-k="elevator">Elevator</button>' +
    "</div>" +
    '<div class="field-row">' +
    "<label>Label</label>" +
    '<input type="text" id="i-conn-label" placeholder="Optional (e.g. east stair)" />' +
    "</div>" +
    '<div class="field-row">' +
    "<label>Direction</label>" +
    '<input type="text" id="i-conn-dir" placeholder="Optional (e.g. turn right, room is on left)" />' +
    "</div>" +
    "</div>" +
    '<div id="block-entrance" class="log-block' + (modeEnt ? "" : " hidden") + '">' +
    '<div class="field-row">' +
    "<label>Name</label>" +
    '<input type="text" id="i-ent-name" placeholder="Entrance name" />' +
    "</div>" +
    '<div class="field-row">' +
    "<label>Face</label>" +
    '<select id="i-ent-ori">' + orientationOptionsHTML(S.entranceOrientation) + "</select>" +
    "</div>" +
    "</div>" +
    '<button class="log-btn log-wide" id="log">' + esc(logButtonLabel()) + "</button>" +
    '<button class="notes-tog" id="ntog">+ notes</button>' +
    '<textarea class="notes hidden" id="nfield" placeholder="Notes..."></textarea>' +
    '<div class="toolbar">' +
    '<div class="toolbar-ct">' + S.entries.length + " entr" + (S.entries.length !== 1 ? "ies" : "y") + "</div>" +
    '<div class="toolbar-acts">' +
    (S.entries.length ? '<button class="exp-btn" id="exp">Export CSV</button>' : "") +
    '<button class="end-btn" id="end">End</button>' +
    "</div>" +
    "</div>" +
    '<div class="entries">' + listHTML + "</div>" +
    "</div>";

  initMap();

  // ── Wire events ──────────────────────────────────────────────
  document.getElementById("recenter").onclick = function () {
    recenterToGPS();
    updateClosestPreview();
  };

  var ib = $("#i-bldg"),
      ifl = $("#i-floor"),
      icf = $("#i-floor-from"),
      ict = $("#i-floor-to"),
      ir = $("#i-room");
  var nf = $("#nfield"), nt = $("#ntog");
  var icl = $("#i-conn-label");
  var icd = $("#i-conn-dir");
  var ien = $("#i-ent-name");
  var ieo = $("#i-ent-ori");

  $("#m-room").onclick = function () { S.logMode = "room"; render(); };
  $("#m-connector").onclick = function () { S.logMode = "connector"; render(); };
  $("#m-entrance").onclick = function () { S.logMode = "entrance"; render(); };

  $("#ck-stairs").onclick = function () { S.connectorKind = "stairs"; render(); };
  $("#ck-elev").onclick = function () { S.connectorKind = "elevator"; render(); };

  if (ib && !bL)
    ib.oninput = function () { S.bldg = ib.value; updateClosestPreview(); };
  if (ifl && !fL) ifl.oninput = function () { S.floor = ifl.value; };
  if (icf && !fL) icf.oninput = function () { S.floorFrom = icf.value; };
  if (ict && !fL) ict.oninput = function () { S.floorTo = ict.value; };
  if (ieo) ieo.onchange = function () { S.entranceOrientation = ieo.value; };

  var eb = $("#e-bldg");
  if (eb) eb.onclick = function () {
    S.bldgLock = false;
    render();
    setTimeout(function () { var el = $("#i-bldg"); if (el) el.focus(); }, 20);
  };
  var ef = $("#e-floor");
  if (ef) ef.onclick = function () {
    S.floorLock = false;
    render();
    setTimeout(function () {
      var el = modeConn ? $("#i-floor-from") : $("#i-floor");
      if (el) el.focus();
    }, 20);
  };

  if (nt && nf) nt.onclick = function () {
    var show = nf.classList.contains("hidden");
    if (show) nf.classList.remove("hidden");
    else nf.classList.add("hidden");
    nt.textContent = show ? "- notes" : "+ notes";
    nt.className = "notes-tog" + (show ? " on" : "");
    if (show) nf.focus();
  };

  var doLog = function () {
    if (!S.bldg.trim() || !S.pinPos) return;

    var entry = {
      id: Date.now(),
      bldg: S.bldg.trim(),
      floor: S.floor.trim() || "\u2014",
      notes: nf ? nf.value.trim() : "",
      lat: S.pinPos.lat,
      lng: S.pinPos.lng,
      ts: new Date().toISOString(),
      kind: "room",
      room: "",
    };

    if (S.logMode === "room") {
      var room = ir ? ir.value.trim() : "";
      if (!room) return;
      entry.kind = "room";
      entry.room = room;
      var near = findClosestEntrance(S.bldg, S.pinPos);
      entry.closestEntrance = near ? near.label : "";
      var nearStair = findClosestConnector(S.bldg, S.pinPos, "stairs");
      entry.closestStair = nearStair ? nearStair.name : "";
      var nearElev = findClosestConnector(S.bldg, S.pinPos, "elevator");
      entry.closestElevator = nearElev ? nearElev.name : "";
    } else if (S.logMode === "connector") {
      var ff = icf ? icf.value.trim() : "";
      var ft = ict ? ict.value.trim() : "";
      if (!ff || !ft) return;
      entry.kind = "connector";
      entry.connectorKind = S.connectorKind;
      entry.floorFrom = ff;
      entry.floorTo = ft;
      entry.floor = formatFloorRange(ff, ft);
      S.floor = entry.floor;
      var lab = icl ? icl.value.trim() : "";
      entry.room =
        lab || (S.connectorKind === "elevator" ? "Elevator" : "Stairs");
      entry.directionFromConnector = icd ? icd.value.trim() : "";
    } else {
      var ename = ien ? ien.value.trim() : "";
      if (!ename) return;
      entry.kind = "entrance";
      entry.room = ename;
      entry.orientation = ieo ? ieo.value : S.entranceOrientation;
    }

    S.entries.unshift(entry);
    if (!S.bldgLock) S.bldgLock = true;
    if (!S.floorLock) S.floorLock = true;

    pushMarkerForEntry(entry);
    renderList();

    if (ir) ir.value = "";
    if (icl) icl.value = "";
    if (icd) icd.value = "";
    if (ien) ien.value = "";
    if (nf) { nf.value = ""; nf.classList.add("hidden"); }
    if (nt) { nt.textContent = "+ notes"; nt.className = "notes-tog"; }
    updateClosestPreview();
    setTimeout(function () {
      if (S.logMode === "room" && ir) ir.focus();
      else if (S.logMode === "connector" && icl) icl.focus();
      else if (S.logMode === "entrance" && ien) ien.focus();
    }, 20);
  };

  $("#log").onclick = doLog;

  function bindEnter(el) {
    if (!el) return;
    el.onkeydown = function (e) { if (e.key === "Enter") doLog(); };
  }
  bindEnter(ir);
  bindEnter(icl);
  bindEnter(icd);
  bindEnter(ien);
  bindEnter(icf);
  bindEnter(ict);

  $("#end").onclick = function () {
    S.screen = "idle";
    stopGPS();
    render();
  };
  var ex = $("#exp");
  if (ex) ex.onclick = doExport;

  wireDeleteButtons();
  updateClosestPreview();
}

function renderList() {
  var listEl = app.querySelector(".entries");
  var toolbarCt = app.querySelector(".toolbar-ct");
  var toolbarActs = app.querySelector(".toolbar-acts");

  if (!listEl) return;

  toolbarCt.textContent =
    S.entries.length + " entr" + (S.entries.length !== 1 ? "ies" : "y");

  if (S.entries.length && !document.getElementById("exp")) {
    var expBtn = document.createElement("button");
    expBtn.className = "exp-btn";
    expBtn.id = "exp";
    expBtn.textContent = "Export CSV";
    expBtn.onclick = doExport;
    toolbarActs.insertBefore(expBtn, toolbarActs.firstChild);
  }

  if (S.entries.length === 0) {
    listEl.innerHTML = '<div class="empty">Nothing logged yet</div>';
  } else {
    listEl.innerHTML = S.entries.map(function (e, i) {
      var n = S.entries.length - i;
      return entryListItemHTML(e, n);
    }).join("");
  }

  wireDeleteButtons();
}

function wireDeleteButtons() {
  var dels = app.querySelectorAll(".entry-del");
  dels.forEach(function (b) {
    b.onclick = function () {
      S.entries = S.entries.filter(function (e) {
        return e.id !== Number(b.dataset.id);
      });
      refreshLoggedMarkers();
      renderList();
      updateClosestPreview();
    };
  });
}

render();

})();
