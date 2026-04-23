// ── config ─────────────────────────────────────────────────────
//
// Read from the <script id="map-config"> JSON blob injected by the
// Flask template (main.tools_edit). The config shape matches the main
// map page (martinBase, center, zoom) so we stay consistent with
// map.js and survey.js.
const CFG = (function () {
  const defaults = {
    martinUrl: 'http://127.0.0.1:3000',
    center: [-73.90665154393827, 41.69664534616691],
    zoom: 12.6,
  };
  const el = document.getElementById('map-config');
  if (!el) return defaults;
  try {
    const parsed = JSON.parse(el.textContent);
    return {
      martinUrl: (parsed.martinBase || parsed.martinUrl || defaults.martinUrl).replace(/\/+$/, ''),
      center: Array.isArray(parsed.center) && parsed.center.length === 2
        ? parsed.center : defaults.center,
      zoom: Number.isFinite(parsed.zoom) ? parsed.zoom : defaults.zoom,
    };
  } catch (_) {
    return defaults;
  }
})();

// ── state ─────────────────────────────────────────────────────────
const allEntries = [];
const entryMarkers = new Map();  // entry -> maplibregl.Marker
const headersByBuilding = {};
let markers = [];                // maplibregl.Marker[]
let pinned = null;

const DEFAULT_HEADERS = [
  '#', 'Kind', 'Subtype', 'Orientation', 'Closest entrance',
  'Closest entrance (elevator)',
  'Building', 'Floor', 'Room', 'Latitude', 'Longitude', 'Notes',
  'Closest stair', 'Closest elevator', 'Direction from connector',
  'Connections',
  'Date', 'Time', 'Timestamp',
];

const draft = {
  kind: 'room', bldg: '', floor: '', name: '', ori: 'N',
  lat: null, lng: null, notes: '',
};
let panelOpen = false;
let panelMode = 'add';
let editingEntry = null;
let editMode = false;
let routeMode = false;
let hallwayMode = false;
let draftMarker = null;
let preferElevator = false;

// Routing state
let routeStart = null;
let routeEnd = null;
let routeRingMarkers = [];
let routeHasFeatures = false;  // mirrors whether the ROUTE_SRC has features

// Hallway drawing state
let lastHallNode = null;
let lastHallAdded = null;

// ── icon SVGs (keep existing silhouettes) ────────────────────────
const SVG_ROOM = '<svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="#5a5" stroke="#111" stroke-width="1.5"/></svg>';
const SVG_ENTRANCE = '<svg width="14" height="16" viewBox="0 0 14 16"><rect x="2" y="2" width="10" height="13" rx="1.5" fill="#5a9fff" stroke="#111" stroke-width="1.5"/><circle cx="9.5" cy="9" r="0.9" fill="#111"/></svg>';
const SVG_STAIRS = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2 L12 12 L2 12 Z" fill="#daa520" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const SVG_ELEVATOR = '<svg width="14" height="16" viewBox="0 0 14 16"><rect x="2" y="2" width="10" height="13" rx="1.5" fill="#6af" stroke="#111" stroke-width="1.5"/><path d="M5 6 L7 4 L9 6 M5 11 L7 13 L9 11" fill="none" stroke="#111" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_HALLWAY = '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" fill="#888" stroke="#111" stroke-width="1"/></svg>';
const SVG_HALLWAY_ACTIVE = '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="#f39c12" stroke="#fff" stroke-width="2"/></svg>';

function svgFor(e) {
  if (e.Kind === 'entrance') return { svg: SVG_ENTRANCE, cls: 'entrance' };
  if (e.Kind === 'connector') {
    return e.Subtype === 'elevator'
      ? { svg: SVG_ELEVATOR, cls: 'elevator' }
      : { svg: SVG_STAIRS, cls: 'stairs' };
  }
  if (e.Kind === 'hallway') {
    return (e === lastHallNode)
      ? { svg: SVG_HALLWAY_ACTIVE, cls: 'hallway-active' }
      : { svg: SVG_HALLWAY, cls: 'hallway' };
  }
  return { svg: SVG_ROOM, cls: 'room' };
}

document.getElementById('leg-room').innerHTML = SVG_ROOM;
document.getElementById('leg-entrance').innerHTML = SVG_ENTRANCE;
document.getElementById('leg-stairs').innerHTML = SVG_STAIRS;
document.getElementById('leg-elevator').innerHTML = SVG_ELEVATOR;
document.getElementById('leg-hallway').innerHTML = SVG_HALLWAY;

// ── map init ─────────────────────────────────────────────────────
//
// Mirrors the style in app/static/map.js but slimmed down to what the viz
// needs: a dark background, landuse, buildings, paths, roads. No labels
// (no glyph server available), no 3D, no hover highlight.
//
// If the configured Martin URL is unreachable the tile layers render
// blank; the marker layer still works so you can place points against a
// plain dark backdrop. We don't fail hard.
const PATH_KINDS = ['footway','path','pedestrian','cycleway','track','bridleway','corridor'];
const STAIR_KINDS = ['steps'];
const MAJOR_ROADS = ['motorway','trunk','primary','secondary','tertiary',
  'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link'];
const MINOR_ROADS = ['residential','service','unclassified','living_street','road'];
const GREEN_LANDUSE = ['grass','park','recreation_ground','meadow','forest','cemetery','village_green'];
const GREEN_LEISURE = ['park','garden','pitch','playground','nature_reserve','golf_course'];

// Dark palette so the colored markers pop.
const C = {
  bg: '#0f0f0f',
  green: '#1e2a1a',
  campus: '#1a1a1a',
  paved: '#242322',
  building: '#2a2622',
  buildOutline: '#463d30',
  water: '#14242b',
  majorFill: '#3a332a',
  majorCase: '#22201c',
  minorFill: '#2a2926',
  minorCase: '#1f1e1c',
  pathFill: '#8a5b2c',
  pathCasing: '#2a2520',
  pathStairs: '#6e4418',
};

const tiles = (table) => `${CFG.martinUrl}/${table}/{z}/{x}/{y}`;

const style = {
  version: 8,
  sources: {
    osm_polygon: { type: 'vector', tiles: [tiles('planet_osm_polygon')], minzoom: 0, maxzoom: 16 },
    osm_line:    { type: 'vector', tiles: [tiles('planet_osm_line')],    minzoom: 0, maxzoom: 16 },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },
    {
      id: 'landuse-green', type: 'fill',
      source: 'osm_polygon', 'source-layer': 'planet_osm_polygon',
      filter: ['any',
        ['in', ['get', 'landuse'], ['literal', GREEN_LANDUSE]],
        ['in', ['get', 'leisure'], ['literal', GREEN_LEISURE]],
        ['in', ['get', 'natural'], ['literal', ['wood','scrub','grassland']]],
      ],
      paint: { 'fill-color': C.green, 'fill-opacity': 0.9 },
    },
    {
      id: 'landuse-campus', type: 'fill',
      source: 'osm_polygon', 'source-layer': 'planet_osm_polygon',
      filter: ['in', ['get','amenity'], ['literal', ['school','university','college']]],
      paint: { 'fill-color': C.campus },
    },
    {
      id: 'landuse-paved', type: 'fill',
      source: 'osm_polygon', 'source-layer': 'planet_osm_polygon',
      filter: ['any',
        ['==', ['get','amenity'], 'parking'],
        ['==', ['get','landuse'], 'residential'],
        ['==', ['get','landuse'], 'commercial'],
      ],
      paint: { 'fill-color': C.paved },
    },
    {
      id: 'water-fill', type: 'fill',
      source: 'osm_polygon', 'source-layer': 'planet_osm_polygon',
      filter: ['any',
        ['==', ['get','natural'], 'water'],
        ['==', ['get','waterway'], 'riverbank'],
        ['==', ['get','landuse'], 'reservoir'],
      ],
      paint: { 'fill-color': C.water },
    },
    {
      id: 'roads-minor-casing', type: 'line',
      source: 'osm_line', 'source-layer': 'planet_osm_line',
      filter: ['in', ['get','highway'], ['literal', MINOR_ROADS]], minzoom: 12,
      layout: { 'line-cap':'round', 'line-join':'round' },
      paint: { 'line-color': C.minorCase,
        'line-width': ['interpolate',['linear'],['zoom'],12,1.2,18,9] },
    },
    {
      id: 'roads-minor', type: 'line',
      source: 'osm_line', 'source-layer': 'planet_osm_line',
      filter: ['in', ['get','highway'], ['literal', MINOR_ROADS]], minzoom: 12,
      layout: { 'line-cap':'round', 'line-join':'round' },
      paint: { 'line-color': C.minorFill,
        'line-width': ['interpolate',['linear'],['zoom'],12,0.5,18,7] },
    },
    {
      id: 'roads-major-casing', type: 'line',
      source: 'osm_line', 'source-layer': 'planet_osm_line',
      filter: ['in', ['get','highway'], ['literal', MAJOR_ROADS]],
      layout: { 'line-cap':'round', 'line-join':'round' },
      paint: { 'line-color': C.majorCase,
        'line-width': ['interpolate',['linear'],['zoom'],10,1.2,18,15] },
    },
    {
      id: 'roads-major', type: 'line',
      source: 'osm_line', 'source-layer': 'planet_osm_line',
      filter: ['in', ['get','highway'], ['literal', MAJOR_ROADS]],
      layout: { 'line-cap':'round', 'line-join':'round' },
      paint: { 'line-color': C.majorFill,
        'line-width': ['interpolate',['linear'],['zoom'],10,0.6,18,11] },
    },
    {
      id: 'buildings', type: 'fill',
      source: 'osm_polygon', 'source-layer': 'planet_osm_polygon',
      filter: ['has','building'],
      paint: { 'fill-color': C.building, 'fill-opacity': 1 },
    },
    {
      id: 'buildings-outline', type: 'line',
      source: 'osm_polygon', 'source-layer': 'planet_osm_polygon',
      filter: ['has','building'],
      paint: { 'line-color': C.buildOutline,
        'line-width': ['interpolate',['linear'],['zoom'],14,0.6,20,1.8] },
    },
    {
      id: 'paths-casing', type: 'line',
      source: 'osm_line', 'source-layer': 'planet_osm_line',
      filter: ['in', ['get','highway'], ['literal', PATH_KINDS.concat(STAIR_KINDS)]],
      minzoom: 12,
      layout: { 'line-cap':'round', 'line-join':'round' },
      paint: { 'line-color': C.pathCasing,
        'line-width': ['interpolate',['linear'],['zoom'],12,1.5,15,4,19,9],
        'line-opacity': 0.95 },
    },
    {
      id: 'paths', type: 'line',
      source: 'osm_line', 'source-layer': 'planet_osm_line',
      filter: ['in', ['get','highway'], ['literal', PATH_KINDS]], minzoom: 12,
      layout: { 'line-cap':'butt', 'line-join':'round' },
      paint: { 'line-color': C.pathFill,
        'line-width': ['interpolate',['linear'],['zoom'],12,0.8,15,1.8,19,4],
        'line-dasharray': [2, 1.25] },
    },
    {
      id: 'paths-stairs', type: 'line',
      source: 'osm_line', 'source-layer': 'planet_osm_line',
      filter: ['in', ['get','highway'], ['literal', STAIR_KINDS]], minzoom: 14,
      layout: { 'line-cap':'butt', 'line-join':'round' },
      paint: { 'line-color': C.pathStairs,
        'line-width': ['interpolate',['linear'],['zoom'],14,2,19,6],
        'line-dasharray': [0.6, 0.5] },
    },
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: CFG.center,
  zoom: CFG.zoom,
  minZoom: 10,
  maxZoom: 21,
  attributionControl: true,
  antialias: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

map.on('error', (e) => {
  if (e && e.error) console.warn('[map]', e.error.message || e.error, e.source || '');
});

// Viz overlay GeoJSON sources: one for relationship (hover) lines,
// one for hallway edges, one for the computed route.
const REL_SRC = 'viz-rel';
const HALL_SRC = 'viz-hallway';
const ROUTE_SRC = 'viz-route';

function addSources() {
  if (!map.getSource(REL_SRC)) {
    map.addSource(REL_SRC, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }
  if (!map.getSource(HALL_SRC)) {
    map.addSource(HALL_SRC, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }
  if (!map.getSource(ROUTE_SRC)) {
    map.addSource(ROUTE_SRC, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }

  // Hallway edges render under everything else viz-related.
  map.addLayer({
    id: 'viz-hallway-line',
    type: 'line',
    source: HALL_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#888', 'line-width': 2, 'line-opacity': 0.65 },
  });

  // Route line: fat orange. Casing beneath it improves contrast.
  map.addLayer({
    id: 'viz-route-casing',
    type: 'line',
    source: ROUTE_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#000', 'line-width': 7, 'line-opacity': 0.5 },
  });
  map.addLayer({
    id: 'viz-route-line',
    type: 'line',
    source: ROUTE_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f39c12', 'line-width': 4, 'line-opacity': 0.95 },
  });

  // Dashed relationship lines for hover. Painted above route line so they
  // remain readable when routing and hover happen together.
  map.addLayer({
    id: 'viz-rel-line',
    type: 'line',
    source: REL_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 3,
      'line-opacity': 0.85,
      'line-dasharray': [2, 2.2],
    },
  });
}

let mapReady = false;
map.on('load', () => {
  addSources();
  mapReady = true;
  map.resize();
  if (allEntries.length) render();
});

map.on('click', (ev) => {
  if (hallwayMode) {
    handleHallwayMapClick(ev.lngLat);
    return;
  }
  if (panelOpen && panelMode === 'add') {
    setDraftLocation(ev.lngLat.lat, ev.lngLat.lng);
  } else if (!panelOpen && !routeMode && pinned) {
    pinned = null; clearRelLines(); hideInfo();
  }
});

// ── CSV parsing / writing ────────────────────────────────────────
function parseRow(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseRow(lines[0]);
  const rows = lines.slice(1).map(line => {
    const vals = parseRow(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] ?? '').trim());
    return obj;
  });
  return { headers, rows };
}

function csvEscape(s) {
  s = String(s ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function writeCSV(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((row, i) => {
    const vals = headers.map(h => {
      if (h === '#') return String(i + 1);
      return csvEscape(row[h] ?? '');
    });
    lines.push(vals.join(','));
  });
  return lines.join('\n');
}

function ensureColumn(building, column) {
  const headers = (headersByBuilding[building] || DEFAULT_HEADERS).slice();
  if (!headers.includes(column)) {
    const insertIdx = headers.indexOf('Date');
    if (insertIdx >= 0) headers.splice(insertIdx, 0, column);
    else headers.push(column);
    headersByBuilding[building] = headers;
  } else {
    headersByBuilding[building] = headers;
  }
}

function downloadCSVs() {
  const byBldg = {};
  allEntries.forEach(e => {
    const b = (e.Building || 'unknown').trim();
    (byBldg[b] = byBldg[b] || []).push(e);
  });
  for (const [bldg, rows] of Object.entries(byBldg)) {
    const headers = headersByBuilding[bldg] || DEFAULT_HEADERS;
    const csv = writeCSV(headers, rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = bldg.replace(/\s+/g, '-') + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

document.getElementById('dl').onclick = downloadCSVs;

document.getElementById('files').onchange = async (ev) => {
  for (const file of ev.target.files) {
    const text = await file.text();
    const { headers, rows } = parseCSV(text);
    allEntries.push(...rows);
    rows.forEach(r => {
      if (r.Building) headersByBuilding[r.Building.trim()] = headers;
    });
  }
  ev.target.value = '';
  updateFilters();
  updateBuildingDatalist();
  render();
  document.getElementById('dl').style.display = '';
};

// ── floors ───────────────────────────────────────────────────────
function allBuildingFloors(building) {
  const floors = new Set();
  for (const e of allEntries) {
    if (e.Building !== building) continue;
    if (e.Kind === 'hallway') continue;
    const f = (e.Floor || '').replace('–', '-').trim();
    if (!f || f === '—' || f === '*') continue;
    const m = f.match(/^(-?\d+)-(-?\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      for (let i = Math.min(a,b); i <= Math.max(a,b); i++) floors.add(String(i));
    } else {
      floors.add(f);
    }
  }
  return [...floors];
}

function expandFloors(e) {
  const f = (e.Floor || '').replace('–', '-').trim();
  if (!f || f === '—') return [];
  if (f === '*') return allBuildingFloors(e.Building);
  const m = f.match(/^(-?\d+)-(-?\d+)$/);
  if (!m) return [f];
  const out = [];
  const a = +m[1], b = +m[2];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(String(i));
  return out;
}

function floorMatches(e, filterFloor) {
  if (!filterFloor) return true;
  return expandFloors(e).includes(filterFloor);
}

// ── filters ──────────────────────────────────────────────────────
function uniqSorted(arr) {
  return [...new Set(arr.filter(v => v && v !== '—'))].sort((a, b) => {
    const na = +a, nb = +b;
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}

function updateFilters() {
  const bldgs = uniqSorted(allEntries.map(e => e.Building));
  const floors = uniqSorted(
    allEntries.filter(e => e.Kind !== 'hallway').flatMap(expandFloors)
  );
  const bldgSel = document.getElementById('f-bldg');
  const floorSel = document.getElementById('f-floor');
  const prevB = bldgSel.value, prevF = floorSel.value;
  bldgSel.innerHTML = '<option value="">all buildings</option>' +
    bldgs.map(b => `<option>${b}</option>`).join('');
  floorSel.innerHTML = '<option value="">all floors</option>' +
    floors.map(f => `<option>${f}</option>`).join('');
  if (bldgs.includes(prevB)) bldgSel.value = prevB;
  if (floors.includes(prevF)) floorSel.value = prevF;
}

function updateBuildingDatalist() {
  const bldgs = uniqSorted(allEntries.map(e => e.Building));
  document.getElementById('bldg-list').innerHTML =
    bldgs.map(b => `<option value="${b}">`).join('');
}

document.getElementById('f-bldg').onchange = () => { render(); syncHallwayPanel(); };
document.getElementById('f-floor').onchange = render;

// ── rendering ────────────────────────────────────────────────────
function makeMarkerEl(entry) {
  const { svg, cls } = svgFor(entry);
  const el = document.createElement('div');
  el.className = 'mm-marker mm-marker--' + cls;
  el.innerHTML = svg;
  return el;
}

function refreshMarkerIcon(entry) {
  const marker = entryMarkers.get(entry);
  if (!marker) return;
  const el = marker.getElement();
  const { svg, cls } = svgFor(entry);
  // Strip every mm-marker--* modifier, then apply the current one.
  el.className = el.className.split(/\s+/)
    .filter(c => !c.startsWith('mm-marker--')).join(' ').trim() + ' mm-marker--' + cls;
  el.innerHTML = svg;
}

function drawHallwayEdges(filtered) {
  if (!mapReady) return;
  const halls = filtered.filter(e => e.Kind === 'hallway');
  const hallById = new Map();
  halls.forEach(h => hallById.set(h.Building + '|' + h.Room, h));
  const features = [];
  const drawn = new Set();
  for (const n of halls) {
    const conns = (n.Connections || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const id of conns) {
      const tgt = hallById.get(n.Building + '|' + id);
      if (!tgt) continue;
      const key = [n.Room, id].sort().join('|') + '|' + n.Building;
      if (drawn.has(key)) continue;
      drawn.add(key);
      features.push({
        type: 'Feature', geometry: {
          type: 'LineString',
          coordinates: [
            [+n.Longitude, +n.Latitude],
            [+tgt.Longitude, +tgt.Latitude],
          ],
        }, properties: {},
      });
    }
  }
  const src = map.getSource(HALL_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features });
}

function render() {
  markers.forEach(m => m.remove());
  markers = [];
  entryMarkers.clear();
  clearRelLines();
  hideInfo();
  pinned = null;

  const b = document.getElementById('f-bldg').value;
  const f = document.getElementById('f-floor').value;
  const filtered = allEntries.filter(e =>
    (!b || e.Building === b) && floorMatches(e, f)
  );
  document.getElementById('count').textContent =
    `${filtered.length} / ${allEntries.length}`;

  if (!mapReady) return;

  filtered.forEach(addMarker);
  drawHallwayEdges(filtered);

  if (filtered.length && !draftMarker && !isRouteDrawn()) {
    const bounds = new maplibregl.LngLatBounds();
    for (const e of filtered) bounds.extend([+e.Longitude, +e.Latitude]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 19, duration: 0 });
  }

  if (routeStart && routeEnd) redrawRoute();
}

function addMarker(entry) {
  const el = makeMarkerEl(entry);
  const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: editMode })
    .setLngLat([+entry.Longitude, +entry.Latitude])
    .addTo(map);

  el.addEventListener('mouseenter', () => {
    if (pinned || routeMode || hallwayMode) return;
    showRelationships(entry);
    showInfo(entry);
  });
  el.addEventListener('mouseleave', () => {
    if (pinned || routeMode || hallwayMode) return;
    clearRelLines();
    hideInfo();
  });
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (hallwayMode) {
      if (entry.Kind === 'hallway') {
        handleHallwayMarkerClick(entry, ev.shiftKey);
      }
      return;
    }
    if (routeMode) {
      handleRouteMarkerClick(entry);
    } else if (editMode) {
      openEditPanel(entry);
    } else if (pinned === entry) {
      pinned = null; clearRelLines(); hideInfo();
    } else {
      pinned = entry;
      clearRelLines();
      showRelationships(entry);
      showInfo(entry);
    }
  });

  marker.on('dragend', () => {
    const pos = marker.getLngLat();
    entry.Latitude = pos.lat;
    entry.Longitude = pos.lng;
    recomputeAllClosest();
    if (editingEntry === entry) {
      document.getElementById('d-lat').value = pos.lat.toFixed(6);
      document.getElementById('d-lng').value = pos.lng.toFixed(6);
    }
    if (pinned === entry) {
      clearRelLines();
      showRelationships(entry);
      showInfo(entry);
    }
    if (entry.Kind === 'hallway') drawHallwayEdges(currentFiltered());
    if (routeStart === entry || routeEnd === entry) redrawRoute();
  });

  markers.push(marker);
  entryMarkers.set(entry, marker);
}

function currentFiltered() {
  const b = document.getElementById('f-bldg').value;
  const f = document.getElementById('f-floor').value;
  return allEntries.filter(e =>
    (!b || e.Building === b) && floorMatches(e, f)
  );
}

// ── lookups ──────────────────────────────────────────────────────
function findEntrance(building, name) {
  if (!name) return null;
  const base = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return allEntries.find(e =>
    e.Building === building && e.Kind === 'entrance' &&
    (e.Room === name || e.Room === base)
  );
}

function findConnector(building, room, subtype) {
  if (!room) return null;
  return allEntries.find(e =>
    e.Building === building && e.Kind === 'connector' &&
    e.Subtype === subtype && e.Room === room
  );
}

// ── relationship lines (hover) ───────────────────────────────────
let relFeatures = [];

function clearRelLines() {
  relFeatures = [];
  if (!mapReady) return;
  const src = map.getSource(REL_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
}

function commitRelLines() {
  if (!mapReady) return;
  const src = map.getSource(REL_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features: relFeatures });
}

function drawRelLine(srcLL, target, color) {
  if (!target) return;
  relFeatures.push({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [srcLL[1], srcLL[0]],  // source is [lat, lng]; GeoJSON needs [lng, lat]
        [+target.Longitude, +target.Latitude],
      ],
    },
    properties: { color },
  });
}

function showRelationships(entry) {
  relFeatures = [];
  const src = [+entry.Latitude, +entry.Longitude];
  if (entry.Kind === 'room') {
    const entField = preferElevator
      ? 'Closest entrance (elevator)'
      : 'Closest entrance';
    drawRelLine(src, findEntrance(entry.Building, entry[entField]), '#5a9fff');
    drawRelLine(src, findConnector(entry.Building, entry['Closest stair'], 'stairs'), '#daa520');
    drawRelLine(src, findConnector(entry.Building, entry['Closest elevator'], 'elevator'), '#6af');
  } else if (entry.Kind === 'connector') {
    drawRelLine(src, findEntrance(entry.Building, entry['Closest entrance']), '#5a9fff');
  }
  commitRelLines();
}

// ── info panel ───────────────────────────────────────────────────
function row(k, v) {
  if (!v) return '';
  return `<div class="k">${k}</div><div class="v">${v}</div>`;
}

function showInfo(e) {
  const kind = e.Kind + (e.Subtype ? ` · ${e.Subtype}` : '');
  const entViaStair = e['Closest entrance'];
  const entViaElev = e['Closest entrance (elevator)'];
  const preferred = preferElevator ? entViaElev : entViaStair;
  const alternate = preferElevator ? entViaStair : entViaElev;
  const altLabel = preferElevator ? 'via stair' : 'via elevator';
  const entLine = (alternate && alternate !== preferred)
    ? row('Closest entrance', preferred) +
      row(`alternate (${altLabel})`, alternate)
    : row('Closest entrance', preferred);

  document.getElementById('info').innerHTML =
    row('Kind', kind) + row('Building', e.Building) + row('Floor', e.Floor) +
    row('Room', e.Room) + row('Orientation', e.Orientation) +
    entLine +
    row('Closest stair', e['Closest stair']) +
    row('Closest elevator', e['Closest elevator']) +
    row('Connections', e.Connections);
  document.getElementById('info').style.display = 'block';
}

function hideInfo() {
  document.getElementById('info').style.display = 'none';
}

// ── geometry ─────────────────────────────────────────────────────
function haversineM(a, b) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const METERS_PER_FLOOR = 20;

function floorDistance(source, target) {
  const srcFloors = expandFloors(source).map(Number).filter(n => !isNaN(n));
  const tgtFloors = expandFloors(target).map(Number).filter(n => !isNaN(n));
  if (!srcFloors.length || !tgtFloors.length) return 0;
  let best = Infinity;
  for (const s of srcFloors) for (const t of tgtFloors) {
    const d = Math.abs(s - t);
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

function travelDistance(entry, candidate) {
  const horizontal = haversineM(
    [+entry.Latitude, +entry.Longitude],
    [+candidate.Latitude, +candidate.Longitude]
  );
  const vertical = floorDistance(entry, candidate) * METERS_PER_FLOOR;
  return horizontal + vertical;
}

// ── closest computation ──────────────────────────────────────────
function entranceFloors(building) {
  const floors = new Set();
  for (const e of allEntries) {
    if (e.Building !== building || e.Kind !== 'entrance') continue;
    for (const f of expandFloors(e)) {
      const n = Number(f);
      if (!isNaN(n)) floors.add(n);
    }
  }
  return floors;
}

function sourceIsOnEntranceFloor(entry) {
  const entFloors = entranceFloors(entry.Building);
  return expandFloors(entry).map(Number).filter(n => !isNaN(n))
    .some(f => entFloors.has(f));
}

function nearestEntranceToPoint(pos, building) {
  let best = null, bestD = Infinity;
  for (const e of allEntries) {
    if (e.Building !== building || e.Kind !== 'entrance') continue;
    const d = haversineM(pos, [+e.Latitude, +e.Longitude]);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? best.Room : '';
}

function nearestByTravel(entry, filter) {
  const bldg = entry.Building;
  let best = null, bestD = Infinity;
  for (const c of allEntries) {
    if (c === entry || c.Building !== bldg || !filter(c)) continue;
    const d = travelDistance(entry, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function computeClosest(entry) {
  entry['Closest entrance'] = '';
  entry['Closest entrance (elevator)'] = '';
  entry['Closest stair'] = '';
  entry['Closest elevator'] = '';

  if (entry.Kind === 'entrance') return;
  if (entry.Kind === 'hallway') return;
  const bldg = entry.Building;

  if (entry.Kind === 'connector') {
    entry['Closest entrance'] = nearestEntranceToPoint(
      [+entry.Latitude, +entry.Longitude], bldg
    );
    return;
  }

  const closestStair = nearestByTravel(entry,
    c => c.Kind === 'connector' && c.Subtype === 'stairs');
  const closestElev = nearestByTravel(entry,
    c => c.Kind === 'connector' && c.Subtype === 'elevator');

  entry['Closest stair']    = closestStair ? closestStair.Room : '';
  entry['Closest elevator'] = closestElev  ? closestElev.Room  : '';

  if (sourceIsOnEntranceFloor(entry)) {
    const direct = nearestEntranceToPoint(
      [+entry.Latitude, +entry.Longitude], bldg
    );
    entry['Closest entrance'] = direct;
    entry['Closest entrance (elevator)'] = direct;
    return;
  }

  if (closestStair) {
    entry['Closest entrance'] = closestStair['Closest entrance'] || '';
  }
  if (closestElev) {
    entry['Closest entrance (elevator)'] = closestElev['Closest entrance'] || '';
  }
}

function recomputeAllClosest() {
  for (const e of allEntries) if (e.Kind !== 'room') computeClosest(e);
  for (const e of allEntries) if (e.Kind === 'room') computeClosest(e);
}

// ── hallway graph + dijkstra ─────────────────────────────────────
function hallwayNodesOnFloor(building, floor) {
  return allEntries.filter(e =>
    e.Kind === 'hallway' &&
    e.Building === building &&
    expandFloors(e).includes(String(floor))
  );
}

function hallwayGraph(building, floor) {
  const nodes = hallwayNodesOnFloor(building, floor);
  const byId = new Map();
  nodes.forEach(n => byId.set(n.Room, n));
  const edges = new Map();
  for (const n of nodes) {
    const conns = (n.Connections || '').split(',').map(s => s.trim()).filter(Boolean);
    const list = [];
    for (const id of conns) {
      const tgt = byId.get(id);
      if (!tgt) continue;
      const cost = haversineM(
        [+n.Latitude, +n.Longitude],
        [+tgt.Latitude, +tgt.Longitude]
      );
      list.push({ to: tgt, cost });
    }
    edges.set(n, list);
  }
  return { nodes, edges };
}

function dijkstra(graph, source, target) {
  if (source === target) return [source];
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  graph.nodes.forEach(n => dist.set(n, Infinity));
  dist.set(source, 0);
  while (true) {
    let u = null, uDist = Infinity;
    for (const n of graph.nodes) {
      if (visited.has(n)) continue;
      const d = dist.get(n);
      if (d < uDist) { uDist = d; u = n; }
    }
    if (u === null || uDist === Infinity) break;
    if (u === target) break;
    visited.add(u);
    const neighbors = graph.edges.get(u) || [];
    for (const { to, cost } of neighbors) {
      if (visited.has(to)) continue;
      const alt = uDist + cost;
      if (alt < dist.get(to)) {
        dist.set(to, alt);
        prev.set(to, u);
      }
    }
  }
  if (!prev.has(target)) return null;
  const path = [target];
  let cur = target;
  while (prev.has(cur)) {
    cur = prev.get(cur);
    path.unshift(cur);
  }
  return path;
}

function projectPointOnSegment(p, a, b) {
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(p[0] * Math.PI / 180);
  const px = p[1] * mPerLon, py = p[0] * mPerLat;
  const ax = a[1] * mPerLon, ay = a[0] * mPerLat;
  const bx = b[1] * mPerLon, by = b[0] * mPerLat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { point: [a[0], a[1]], t: 0, distM: Math.hypot(px - ax, py - ay) };
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projLng = (ax + t * dx) / mPerLon;
  const projLat = (ay + t * dy) / mPerLat;
  const cx = ax + t * dx, cy = ay + t * dy;
  return {
    point: [projLat, projLng],
    t,
    distM: Math.hypot(px - cx, py - cy),
  };
}

function nearestHallwayEdge(pos, building, floor) {
  const nodes = hallwayNodesOnFloor(building, floor);
  if (nodes.length < 2) return null;
  const byId = new Map();
  nodes.forEach(n => byId.set(n.Room, n));
  let best = null;
  const seen = new Set();
  for (const n of nodes) {
    const conns = (n.Connections || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const id of conns) {
      const tgt = byId.get(id);
      if (!tgt) continue;
      const key = [n.Room, id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const proj = projectPointOnSegment(
        pos,
        [+n.Latitude, +n.Longitude],
        [+tgt.Latitude, +tgt.Longitude]
      );
      if (!best || proj.distM < best.distM) {
        best = { fromNode: n, toNode: tgt, ...proj };
      }
    }
  }
  return best;
}

function routeLegOnFloor(fromLL, toLL, building, floor) {
  const graph = hallwayGraph(building, floor);
  if (graph.nodes.length < 2) return [fromLL, toLL];

  const startEdge = nearestHallwayEdge(fromLL, building, floor);
  const endEdge = nearestHallwayEdge(toLL, building, floor);
  if (!startEdge || !endEdge) return [fromLL, toLL];

  const sameEdge =
    (startEdge.fromNode === endEdge.fromNode && startEdge.toNode === endEdge.toNode) ||
    (startEdge.fromNode === endEdge.toNode && startEdge.toNode === endEdge.fromNode);
  if (sameEdge) {
    return [fromLL, startEdge.point, endEdge.point, toLL];
  }

  const options = [
    [startEdge.fromNode, endEdge.fromNode],
    [startEdge.fromNode, endEdge.toNode],
    [startEdge.toNode, endEdge.fromNode],
    [startEdge.toNode, endEdge.toNode],
  ];
  let bestPath = null, bestCost = Infinity;
  for (const [s, e] of options) {
    const path = dijkstra(graph, s, e);
    if (!path) continue;
    let cost = haversineM(startEdge.point, [+s.Latitude, +s.Longitude]);
    for (let i = 1; i < path.length; i++) {
      cost += haversineM(
        [+path[i-1].Latitude, +path[i-1].Longitude],
        [+path[i].Latitude, +path[i].Longitude]
      );
    }
    cost += haversineM([+e.Latitude, +e.Longitude], endEdge.point);
    if (cost < bestCost) { bestCost = cost; bestPath = { path, s, e }; }
  }
  if (!bestPath) return [fromLL, toLL];

  const pts = [fromLL, startEdge.point];
  for (const node of bestPath.path) {
    pts.push([+node.Latitude, +node.Longitude]);
  }
  pts.push(endEdge.point, toLL);
  return pts;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(points[i-1], points[i]);
  }
  return total;
}

// ── route computation ────────────────────────────────────────────
function parseFloor(e) {
  const floors = expandFloors(e).map(Number).filter(n => !isNaN(n));
  return floors.length ? Math.min(...floors) : NaN;
}

function connectorReaches(c, floor) {
  const floors = expandFloors(c).map(Number).filter(n => !isNaN(n));
  return floors.includes(floor);
}

const START_WEIGHT = 1.0;
const END_WEIGHT = 1.75;
const ON_ROUTE_THRESHOLD_M = 20;

function pickBestConnector(start, end, subtype) {
  const sf = parseFloor(start);
  const ef = parseFloor(end);
  const candidates = allEntries.filter(c =>
    c.Kind === 'connector' &&
    c.Subtype === subtype &&
    c.Building === start.Building &&
    connectorReaches(c, sf) &&
    connectorReaches(c, ef)
  );
  if (!candidates.length) return null;
  let best = null, bestCost = Infinity;
  for (const c of candidates) {
    const dStart = haversineM(
      [+start.Latitude, +start.Longitude],
      [+c.Latitude, +c.Longitude]
    );
    const dEnd = haversineM(
      [+c.Latitude, +c.Longitude],
      [+end.Latitude, +end.Longitude]
    );
    const cost = START_WEIGHT * dStart + END_WEIGHT * dEnd;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best;
}

function pointToSegmentM(p, a, b) {
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(p[0] * Math.PI / 180);
  const px = p[1] * mPerLon, py = p[0] * mPerLat;
  const ax = a[1] * mPerLon, ay = a[0] * mPerLat;
  const bx = b[1] * mPerLon, by = b[0] * mPerLat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function pointToPolylineM(p, points) {
  if (points.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = pointToSegmentM(p, points[i - 1], points[i]);
    if (d < best) best = d;
  }
  return best;
}

function connectorOnRoute(routePoints, start, end, subtype) {
  const sf = parseFloor(start);
  const ef = parseFloor(end);
  const candidates = allEntries.filter(c =>
    c.Kind === 'connector' &&
    c.Subtype === subtype &&
    c.Building === start.Building &&
    connectorReaches(c, sf) &&
    connectorReaches(c, ef)
  );
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const d = pointToPolylineM(
      [+c.Latitude, +c.Longitude],
      routePoints
    );
    if (d <= ON_ROUTE_THRESHOLD_M && d < bestD) {
      bestD = d; best = c;
    }
  }
  return best;
}

function computeRoute(start, end) {
  if (!start || !end) return null;
  if (start === end) return { error: 'start and end are the same point' };
  if (start.Building !== end.Building) {
    return { error: 'different buildings (not yet supported)' };
  }

  const sf = parseFloor(start);
  const ef = parseFloor(end);
  if (isNaN(sf) || isNaN(ef)) return { error: 'invalid floor on start or end' };

  const startLL = [+start.Latitude, +start.Longitude];
  const endLL = [+end.Latitude, +end.Longitude];

  if (sf === ef) {
    const points = routeLegOnFloor(startLL, endLL, start.Building, sf);
    return {
      legs: [{ from: start, to: end, points }],
      sameFloor: true,
      distance: polylineLength(points),
    };
  }

  const primary = preferElevator ? 'elevator' : 'stairs';
  const fallback = preferElevator ? 'stairs' : 'elevator';

  const flatRoute = routeLegOnFloor(startLL, endLL, start.Building, sf);

  let connector = connectorOnRoute(flatRoute, start, end, primary);
  let subtype = primary;
  let onRoute = !!connector;

  if (!connector) {
    connector = connectorOnRoute(flatRoute, start, end, fallback);
    if (connector) subtype = fallback;
  }

  if (!connector) {
    connector = pickBestConnector(start, end, primary);
    subtype = primary;
    if (!connector) {
      connector = pickBestConnector(start, end, fallback);
      subtype = fallback;
    }
  }

  if (!connector) {
    return { error: `no ${primary} or ${fallback} reaches both floors` };
  }

  const connLL = [+connector.Latitude, +connector.Longitude];
  const leg1Pts = routeLegOnFloor(startLL, connLL, start.Building, sf);
  const leg2Pts = routeLegOnFloor(connLL, endLL, start.Building, ef);

  return {
    legs: [
      { from: start, to: connector, points: leg1Pts },
      { from: connector, to: end, points: leg2Pts },
    ],
    connector,
    subtype,
    fromFloor: sf,
    toFloor: ef,
    distance: polylineLength(leg1Pts) + polylineLength(leg2Pts),
    usedFallback: subtype !== primary,
    onRoute,
  };
}

// ── route drawing / panel ────────────────────────────────────────
function isRouteDrawn() {
  return routeHasFeatures;
}

function drawRouteLines(route) {
  if (!mapReady) return;
  const features = [];
  for (const leg of route.legs) {
    const pts = leg.points || [
      [+leg.from.Latitude, +leg.from.Longitude],
      [+leg.to.Latitude, +leg.to.Longitude],
    ];
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: pts.map(([lat, lng]) => [lng, lat]),
      },
      properties: {},
    });
  }
  const src = map.getSource(ROUTE_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features });
  routeHasFeatures = features.length > 0;
}

function clearRouteDrawing() {
  if (mapReady) {
    const src = map.getSource(ROUTE_SRC);
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }
  routeHasFeatures = false;
  routeRingMarkers.forEach(m => m.remove());
  routeRingMarkers = [];
}

function drawRing(entry, kind) {
  const el = document.createElement('div');
  el.className = 'mm-ring mm-ring--' + kind;
  const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([+entry.Longitude, +entry.Latitude])
    .addTo(map);
  routeRingMarkers.push(marker);
}

function redrawRoute() {
  clearRouteDrawing();
  if (!routeStart || !routeEnd) return;
  const route = computeRoute(routeStart, routeEnd);
  updateRouteInfo(route);
  if (route && !route.error) drawRouteLines(route);
  if (routeStart) drawRing(routeStart, 'start');
  if (routeEnd) drawRing(routeEnd, 'end');
}

function fmtEntry(e) {
  const kind = e.Kind === 'connector'
    ? (e.Subtype === 'elevator' ? 'elev' : 'stair')
    : e.Kind;
  return `${e.Building} · F${e.Floor} · ${kind}: ${e.Room || '—'}`;
}

function updateRouteInfo(route) {
  const el = document.getElementById('route-info');
  if (!route) {
    el.classList.remove('error');
    el.innerHTML = '<span class="empty">pick two points to compute a route</span>';
    return;
  }
  if (route.error) {
    el.classList.add('error');
    el.textContent = route.error;
    return;
  }
  el.classList.remove('error');
  let body = '';
  if (route.sameFloor) {
    body = `Same floor · walk ${Math.round(route.distance)} m`;
  } else {
    const subLabel = route.subtype === 'elevator' ? 'elevator' : 'stairs';
    const routeNote = route.onRoute ? ' (on your path)' : '';
    body = `Via ${subLabel} "${route.connector.Room || '—'}"${routeNote} · floor ${route.fromFloor} → ${route.toFloor} · ${Math.round(route.distance)} m walking`;
  }
  if (route.usedFallback) {
    const want = preferElevator ? 'elevator' : 'stairs';
    body += `<div class="note">${want} unavailable — using ${route.subtype}</div>`;
  }
  el.innerHTML = body;
}

function setRouteStart(entry) {
  routeStart = entry;
  const v = document.getElementById('route-start-val');
  const c = document.getElementById('route-start-clear');
  v.textContent = fmtEntry(entry);
  v.classList.remove('empty');
  c.classList.remove('hidden');
  redrawRoute();
}

function setRouteEnd(entry) {
  routeEnd = entry;
  const v = document.getElementById('route-end-val');
  const c = document.getElementById('route-end-clear');
  v.textContent = fmtEntry(entry);
  v.classList.remove('empty');
  c.classList.remove('hidden');
  redrawRoute();
}

function clearRouteStart() {
  routeStart = null;
  const v = document.getElementById('route-start-val');
  const c = document.getElementById('route-start-clear');
  v.textContent = 'click a marker';
  v.classList.add('empty');
  c.classList.add('hidden');
  redrawRoute();
}

function clearRouteEnd() {
  routeEnd = null;
  const v = document.getElementById('route-end-val');
  const c = document.getElementById('route-end-clear');
  v.textContent = 'click a marker';
  v.classList.add('empty');
  c.classList.add('hidden');
  redrawRoute();
}

function handleRouteMarkerClick(entry) {
  if (!routeStart) { setRouteStart(entry); return; }
  if (!routeEnd) {
    if (entry === routeStart) return;
    setRouteEnd(entry);
    return;
  }
  clearRouteEnd();
  setRouteStart(entry);
}

document.getElementById('route-start-clear').onclick = clearRouteStart;
document.getElementById('route-end-clear').onclick = clearRouteEnd;

// ── hallway drawing ──────────────────────────────────────────────
function currentHallwayBuilding() {
  return document.getElementById('f-bldg').value;
}

function currentHallwayFloor() {
  return document.getElementById('hall-floor').value || '*';
}

function nextHallwayId(building) {
  const existing = allEntries.filter(e =>
    e.Kind === 'hallway' && e.Building === building
  );
  let max = 0;
  for (const e of existing) {
    const m = (e.Room || '').match(/^H(\d+)$/);
    if (m) max = Math.max(max, +m[1]);
  }
  return 'H' + (max + 1);
}

function addHallwayNode(lat, lng, building, floor) {
  const now = new Date();
  const id = nextHallwayId(building);
  const entry = {
    '#': '',
    Kind: 'hallway', Subtype: '', Orientation: '',
    'Closest entrance': '', 'Closest entrance (elevator)': '',
    Building: building, Floor: floor, Room: id,
    Latitude: lat, Longitude: lng, Notes: '',
    'Closest stair': '', 'Closest elevator': '',
    'Direction from connector': '',
    Connections: '',
    Date: fmtDate(now), Time: fmtTime(now), Timestamp: now.toISOString(),
  };
  ensureColumn(building, 'Connections');
  allEntries.push(entry);
  return entry;
}

function addConnection(a, b) {
  if (!a || !b || a === b) return;
  const addOne = (from, to) => {
    const parts = (from.Connections || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.includes(to.Room)) parts.push(to.Room);
    from.Connections = parts.join(',');
  };
  addOne(a, b);
  addOne(b, a);
}

function removeConnectionsReferencing(building, roomId) {
  for (const n of allEntries) {
    if (n.Kind !== 'hallway' || n.Building !== building) continue;
    const parts = (n.Connections || '').split(',').map(s => s.trim()).filter(Boolean);
    const filtered = parts.filter(id => id !== roomId);
    if (filtered.length !== parts.length) {
      n.Connections = filtered.join(',');
    }
  }
}

function updateHallStatus() {
  const el = document.getElementById('hall-status');
  if (lastHallNode) {
    el.innerHTML = `<span class="active">last: ${lastHallNode.Room}</span> <span style="color:#555">(F ${lastHallNode.Floor})</span> — click to extend from here`;
  } else {
    el.innerHTML = '<span class="none">no node selected — click map to start</span>';
  }
}

function setLastHallNode(entry) {
  const prev = lastHallNode;
  lastHallNode = entry;
  if (prev) refreshMarkerIcon(prev);
  if (entry) refreshMarkerIcon(entry);
  updateHallStatus();
}

function handleHallwayMapClick(lngLat) {
  const building = currentHallwayBuilding();
  if (!building) {
    alert('Select a building in the filter first');
    return;
  }
  const floor = currentHallwayFloor();
  const newNode = addHallwayNode(lngLat.lat, lngLat.lng, building, floor);
  if (lastHallNode && lastHallNode.Building === building) {
    addConnection(lastHallNode, newNode);
  }
  lastHallAdded = newNode;
  setLastHallNode(newNode);
  render();
}

function handleHallwayMarkerClick(entry, shift) {
  if (!lastHallNode) { setLastHallNode(entry); return; }
  if (shift) {
    if (entry !== lastHallNode) {
      addConnection(lastHallNode, entry);
      setLastHallNode(entry);
      drawHallwayEdges(currentFiltered());
    }
  } else {
    setLastHallNode(entry);
  }
}

document.getElementById('hall-new-seg').onclick = () => {
  setLastHallNode(null);
};

document.getElementById('hall-del-last').onclick = () => {
  if (!lastHallAdded) return;
  const target = lastHallAdded;
  removeConnectionsReferencing(target.Building, target.Room);
  const idx = allEntries.indexOf(target);
  if (idx >= 0) allEntries.splice(idx, 1);
  if (lastHallNode === target) lastHallNode = null;
  lastHallAdded = null;
  updateHallStatus();
  render();
};

document.getElementById('hallway-close').onclick = () => exitHallwayMode();

function populateHallFloorSelect() {
  const sel = document.getElementById('hall-floor');
  const prev = sel.value;
  const building = currentHallwayBuilding();
  const floors = building ? allBuildingFloors(building) : [];
  sel.innerHTML = '<option value="*">* all floors</option>' +
    floors.sort((a,b) => +a - +b).map(f => `<option value="${f}">${f}</option>`).join('');
  if (floors.includes(prev) || prev === '*') sel.value = prev;
}

function syncHallwayPanel() {
  const building = currentHallwayBuilding();
  const bldgEl = document.getElementById('hall-bldg');
  const bodyEl = document.getElementById('hall-body');
  if (!building) {
    bldgEl.textContent = '— select in filter —';
    bldgEl.style.color = '#c66';
    bodyEl.style.opacity = '0.4';
    bodyEl.style.pointerEvents = 'none';
    return;
  }
  bldgEl.textContent = building;
  bldgEl.style.color = '#ccc';
  bodyEl.style.opacity = '';
  bodyEl.style.pointerEvents = '';
  populateHallFloorSelect();
  updateHallStatus();
}

// ── date helpers ─────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(d) { return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function fmtTime(d) { return d.toTimeString().slice(0, 8); }

// ── draft marker (add mode) ──────────────────────────────────────
function setDraftLocation(lat, lng) {
  draft.lat = lat; draft.lng = lng;
  document.getElementById('d-lat').value = lat.toFixed(6);
  document.getElementById('d-lng').value = lng.toFixed(6);
  document.getElementById('loc-hint').textContent =
    'location set — click elsewhere to move';
  if (draftMarker) {
    draftMarker.setLngLat([lng, lat]);
  } else {
    const el = document.createElement('div');
    el.className = 'mm-draft';
    draftMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lng, lat])
      .addTo(map);
  }
}

function clearDraftMarker() {
  if (draftMarker) { draftMarker.remove(); draftMarker = null; }
  draft.lat = null; draft.lng = null;
  document.getElementById('d-lat').value = '';
  document.getElementById('d-lng').value = '';
  document.getElementById('loc-hint').textContent =
    'click the map to set a location';
}

// ── add/edit panel ───────────────────────────────────────────────
function openPanel(mode, entry) {
  panelOpen = true;
  panelMode = mode;
  editingEntry = (mode === 'edit') ? entry : null;
  document.getElementById('panel').classList.add('open');
  document.getElementById('legend').classList.add('hidden');

  const title = document.getElementById('panel-title');
  const primary = document.getElementById('d-primary');
  const del = document.getElementById('d-delete');
  const hint = document.getElementById('loc-hint');

  if (mode === 'add') {
    title.textContent = 'Add point';
    primary.textContent = 'Add point';
    del.classList.add('hidden');
    hint.textContent = 'click the map to set a location';
    document.getElementById('toggle-add').classList.add('active');
    document.body.classList.add('add-mode');
  } else {
    title.textContent = 'Edit point';
    primary.textContent = 'Save changes';
    del.classList.remove('hidden');
    hint.textContent = 'drag the marker to move, or type here';
    draftFromEntry(entry);
    document.body.classList.remove('add-mode');
  }
  syncKindUI();
}

function closePanel() {
  panelOpen = false;
  editingEntry = null;
  document.getElementById('panel').classList.remove('open');
  document.body.classList.remove('add-mode');
  if (!routeMode && !hallwayMode) document.getElementById('legend').classList.remove('hidden');
  document.getElementById('toggle-add').classList.remove('active');
  clearDraftMarker();
}

function openAddPanel() { resetDraft(); syncDraftToForm(); openPanel('add', null); }
function openEditPanel(entry) { openPanel('edit', entry); }

document.getElementById('toggle-add').onclick = () => {
  if (panelOpen && panelMode === 'add') closePanel();
  else openAddPanel();
};
document.getElementById('panel-close').onclick = closePanel;

// ── mode toggles (edit, route, hallway — mutually exclusive) ─────
function setMarkersDraggable(flag) {
  for (const m of markers) {
    if (flag) m.setDraggable(true); else m.setDraggable(false);
  }
}

function toggleEditMode() {
  if (routeMode) exitRouteMode();
  if (hallwayMode) exitHallwayMode();
  editMode = !editMode;
  setMarkersDraggable(editMode);
  document.getElementById('toggle-edit').classList.toggle('active', editMode);
  if (!editMode && panelOpen && panelMode === 'edit') closePanel();
  updateHint();
}

function enterRouteMode() {
  if (editMode) toggleEditMode();
  if (hallwayMode) exitHallwayMode();
  routeMode = true;
  document.getElementById('route-panel').classList.add('open');
  document.getElementById('toggle-route').classList.add('active');
  document.getElementById('legend').classList.add('hidden');
  if (pinned) { pinned = null; clearRelLines(); hideInfo(); }
  updateHint();
}

function exitRouteMode() {
  routeMode = false;
  clearRouteStart();
  clearRouteEnd();
  clearRouteDrawing();
  document.getElementById('route-panel').classList.remove('open');
  document.getElementById('toggle-route').classList.remove('active');
  if (!panelOpen && !hallwayMode) document.getElementById('legend').classList.remove('hidden');
  updateHint();
}

function toggleRouteMode() { routeMode ? exitRouteMode() : enterRouteMode(); }

function enterHallwayMode() {
  if (editMode) toggleEditMode();
  if (routeMode) exitRouteMode();
  if (panelOpen) closePanel();
  hallwayMode = true;
  document.getElementById('hallway-panel').classList.add('open');
  document.getElementById('toggle-hallway').classList.add('active');
  document.getElementById('legend').classList.add('hidden');
  document.body.classList.add('hallway-mode');
  if (pinned) { pinned = null; clearRelLines(); hideInfo(); }
  syncHallwayPanel();
  updateHint();
}

function exitHallwayMode() {
  hallwayMode = false;
  setLastHallNode(null);
  lastHallAdded = null;
  document.getElementById('hallway-panel').classList.remove('open');
  document.getElementById('toggle-hallway').classList.remove('active');
  document.body.classList.remove('hallway-mode');
  if (!panelOpen && !routeMode) document.getElementById('legend').classList.remove('hidden');
  updateHint();
}

function toggleHallwayMode() { hallwayMode ? exitHallwayMode() : enterHallwayMode(); }

document.getElementById('toggle-edit').onclick = toggleEditMode;
document.getElementById('toggle-route').onclick = toggleRouteMode;
document.getElementById('toggle-hallway').onclick = toggleHallwayMode;
document.getElementById('route-close').onclick = exitRouteMode;

function updateHint() {
  const hint = document.getElementById('hint');
  if (hallwayMode) hint.textContent = 'hallway mode: click map to drop + connect, shift+click node to connect';
  else if (routeMode) hint.textContent = 'route mode: click start, then end';
  else if (editMode) hint.textContent = 'edit mode: drag markers, click to edit fields';
  else hint.textContent = 'hover a node to see its closest links';
}

// ── elevator preference ──────────────────────────────────────────
document.getElementById('prefer-elevator').onchange = (e) => {
  preferElevator = e.target.checked;
  if (pinned) {
    clearRelLines();
    showRelationships(pinned);
    showInfo(pinned);
  }
  if (routeStart && routeEnd) redrawRoute();
};

// ── kind pills + form binding ────────────────────────────────────
document.querySelectorAll('.kind-btn').forEach(btn => {
  btn.onclick = () => { draft.kind = btn.dataset.k; syncKindUI(); };
});

function syncKindUI() {
  document.querySelectorAll('.kind-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.k === draft.kind)
  );
  const k = draft.kind;
  const lbl = document.getElementById('name-lbl');
  const nameInput = document.getElementById('d-name');
  document.getElementById('f-ori').classList.toggle('hidden', k !== 'entrance');
  if (k === 'room') {
    lbl.textContent = 'Room number';
    nameInput.placeholder = 'e.g. 2016';
  } else if (k === 'entrance') {
    lbl.textContent = 'Entrance name';
    nameInput.placeholder = 'e.g. Main, NE, Side';
  } else if (k === 'stairs') {
    lbl.textContent = 'Stairs label (optional)';
    nameInput.placeholder = 'e.g. A, B, Main Stairs';
  } else {
    lbl.textContent = 'Elevator label (optional)';
    nameInput.placeholder = 'e.g. Main, Back';
  }
}

document.getElementById('d-bldg').oninput = e => draft.bldg = e.target.value;
document.getElementById('d-floor').oninput = e => draft.floor = e.target.value;
document.getElementById('d-name').oninput = e => draft.name = e.target.value;
document.getElementById('d-ori').onchange = e => draft.ori = e.target.value;
document.getElementById('d-notes').oninput = e => draft.notes = e.target.value;
document.getElementById('d-lat').oninput = e => {
  const v = parseFloat(e.target.value);
  const lng = parseFloat(document.getElementById('d-lng').value);
  if (isFinite(v) && isFinite(lng) && panelMode === 'add') setDraftLocation(v, lng);
};
document.getElementById('d-lng').oninput = e => {
  const v = parseFloat(e.target.value);
  const lat = parseFloat(document.getElementById('d-lat').value);
  if (isFinite(v) && isFinite(lat) && panelMode === 'add') setDraftLocation(lat, v);
};

function resetDraft() {
  draft.name = ''; draft.notes = ''; draft.lat = null; draft.lng = null;
}

function syncDraftToForm() {
  document.getElementById('d-bldg').value = draft.bldg;
  document.getElementById('d-floor').value = draft.floor;
  document.getElementById('d-name').value = draft.name;
  document.getElementById('d-ori').value = draft.ori;
  document.getElementById('d-lat').value = draft.lat != null ? String(draft.lat) : '';
  document.getElementById('d-lng').value = draft.lng != null ? String(draft.lng) : '';
  document.getElementById('d-notes').value = draft.notes;
}

function draftFromEntry(entry) {
  let k = entry.Kind;
  if (entry.Kind === 'connector') {
    k = entry.Subtype === 'elevator' ? 'elevator' : 'stairs';
  }
  draft.kind = k;
  draft.bldg = entry.Building || '';
  draft.floor = entry.Floor || '';
  draft.name = entry.Room || '';
  draft.ori = entry.Orientation || 'N';
  draft.lat = +entry.Latitude;
  draft.lng = +entry.Longitude;
  draft.notes = entry.Notes || '';
  syncDraftToForm();
}

function applyDraftToEntry(entry) {
  const k = draft.kind;
  const kind = (k === 'stairs' || k === 'elevator') ? 'connector' : k;
  const subtype = (k === 'stairs') ? 'stairs' : (k === 'elevator') ? 'elevator' : '';
  const defaultRoom = k === 'stairs' ? 'Stairs' : k === 'elevator' ? 'Elevator' : '';

  const lat = parseFloat(document.getElementById('d-lat').value);
  const lng = parseFloat(document.getElementById('d-lng').value);

  entry.Kind = kind;
  entry.Subtype = subtype;
  entry.Orientation = k === 'entrance' ? draft.ori : '';
  entry.Building = (draft.bldg || '').trim();
  entry.Floor = (draft.floor || '').trim();
  entry.Room = (draft.name || '').trim() || defaultRoom;
  entry.Notes = draft.notes || '';
  if (isFinite(lat)) entry.Latitude = lat;
  if (isFinite(lng)) entry.Longitude = lng;
}

function validateDraft() {
  const k = draft.kind;
  const lat = parseFloat(document.getElementById('d-lat').value);
  const lng = parseFloat(document.getElementById('d-lng').value);
  if (!isFinite(lat) || !isFinite(lng)) { alert('Location required'); return false; }
  if (!(draft.bldg || '').trim()) { alert('Building required'); return false; }
  if (!(draft.floor || '').trim()) { alert('Floor required'); return false; }
  if ((k === 'room' || k === 'entrance') && !(draft.name || '').trim()) {
    alert(k === 'room' ? 'Room number required' : 'Entrance name required');
    return false;
  }
  return true;
}

function saveNewEntry() {
  if (!validateDraft()) return;
  const now = new Date();
  const entry = {
    '#': '',
    Kind: '', Subtype: '', Orientation: '', 'Closest entrance': '',
    'Closest entrance (elevator)': '',
    Building: '', Floor: '', Room: '', Latitude: 0, Longitude: 0, Notes: '',
    'Closest stair': '', 'Closest elevator': '', 'Direction from connector': '',
    Connections: '',
    Date: fmtDate(now), Time: fmtTime(now), Timestamp: now.toISOString(),
  };
  applyDraftToEntry(entry);
  allEntries.push(entry);
  if (!headersByBuilding[entry.Building]) {
    headersByBuilding[entry.Building] = DEFAULT_HEADERS;
  }
  recomputeAllClosest();
  resetDraft();
  syncDraftToForm();
  clearDraftMarker();
  updateFilters();
  updateBuildingDatalist();
  render();
  document.getElementById('dl').style.display = '';
  document.getElementById('d-name').focus();
}

function saveEditedEntry() {
  if (!editingEntry) return;
  if (!validateDraft()) return;
  applyDraftToEntry(editingEntry);
  recomputeAllClosest();
  updateFilters();
  updateBuildingDatalist();
  closePanel();
  render();
}

function deleteCurrentEntry() {
  if (!editingEntry) return;
  if (!confirm('Delete this point?')) return;
  if (editingEntry.Kind === 'hallway') {
    removeConnectionsReferencing(editingEntry.Building, editingEntry.Room);
  }
  const idx = allEntries.indexOf(editingEntry);
  if (idx >= 0) allEntries.splice(idx, 1);
  if (editingEntry === routeStart) clearRouteStart();
  if (editingEntry === routeEnd) clearRouteEnd();
  if (editingEntry === lastHallNode) lastHallNode = null;
  recomputeAllClosest();
  closePanel();
  updateFilters();
  updateBuildingDatalist();
  render();
}

document.getElementById('d-primary').onclick = () => {
  if (panelMode === 'add') saveNewEntry();
  else saveEditedEntry();
};
document.getElementById('d-delete').onclick = deleteCurrentEntry;

document.getElementById('d-name').onkeydown = (e) => {
  if (e.key === 'Enter') document.getElementById('d-primary').click();
};

window.addEventListener('resize', () => map.resize());
