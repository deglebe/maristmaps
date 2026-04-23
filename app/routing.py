"""
inter-building routing over campus paths
end-to-end so the rest has something to plug into, should be extensible to the intra-building routing

build_graph() -> nx.Graph of every walkable osm way on campus (does include roads)
shortest_path(src, dst) -> route with trackpoints + distance + duration
route_to_gpx(route) -> gpx 1.1 xml string suitable for download (we should use gpxpy for this)

campus is small enough that networkx is fast enough for this, which is nice since gpx is xml
edges are weighted by haversine distance in metres, there is a penalty for stairs and roads, so paths are preferred
after the osm import we also synthesize "crossing" edges (dangling sidewalk ends + road
junctions -> nearest path) so routes can cut across intersections osm didn't wire up
coordinates are (lon, lat) in espg:4326 which matches geojson and maplibre
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Sequence

import networkx as nx
import numpy as np
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.extensions import db

_log = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# area filter (shared with osm_features)
# -----------------------------------------------------------------------------
#
# The PBF can legitimately cover far more ground than "campus": our
# current extract includes the river and most of Poughkeepsie. Routing,
# search, and graph-build all get painfully slow when they walk every
# way in that dataset on every startup. We clip everything to a disc
# around MAP_CENTER_{LON,LAT} with radius MAP_FEATURE_RADIUS_M (env,
# meters). Set MAP_FEATURE_RADIUS_M=0 to disable the filter.


_DEFAULT_CENTER_LON = -73.90665154393827
_DEFAULT_CENTER_LAT = 41.69664534616691
_DEFAULT_RADIUS_M = 6000.0


def area_params() -> dict:
    """Read the campus-area filter (center + radius) from env.

    Returns a dict with ``lon``, ``lat``, ``radius_m``. ``radius_m`` may
    be 0 / negative to disable filtering.
    """
    try:
        lon = float(os.environ.get("MAP_CENTER_LON", _DEFAULT_CENTER_LON))
    except (TypeError, ValueError):
        lon = _DEFAULT_CENTER_LON
    try:
        lat = float(os.environ.get("MAP_CENTER_LAT", _DEFAULT_CENTER_LAT))
    except (TypeError, ValueError):
        lat = _DEFAULT_CENTER_LAT
    try:
        radius = float(os.environ.get("MAP_FEATURE_RADIUS_M", _DEFAULT_RADIUS_M))
    except (TypeError, ValueError):
        radius = _DEFAULT_RADIUS_M
    return {"lon": lon, "lat": lat, "radius_m": radius}


def area_filter_sql() -> str:
    """SQL fragment that clips a row's ``way`` column to the configured disc.

    Keeps everything in the native EPSG:3857 CRS of the ``way`` column so
    PostGIS can use its GIST spatial index directly.  We transform only the
    single center point (cheap) rather than transforming + casting every row
    to geography (the old approach was ~20× slower on large extracts).

    The radius is inflated by 1/cos(lat) to compensate for Web Mercator's
    north–south unit scaling at non-equatorial latitudes.
    """
    if area_params()["radius_m"] <= 0:
        return ""
    return (
        " AND ST_DWithin("
        "way,"
        "ST_Transform(ST_SetSRID(ST_MakePoint(:center_lon, :center_lat), 4326), 3857),"
        ":radius_m_3857)"
    )


def area_filter_params() -> dict:
    """Bind params for area_filter_sql() — empty when the filter is off."""
    p = area_params()
    if p["radius_m"] <= 0:
        return {}
    # Scale the meter radius for EPSG:3857: 1 unit ≈ 1 m / cos(lat) at lat φ.
    # Add 20 % safety margin so features at the edge of the bbox aren't clipped.
    cos_lat = math.cos(math.radians(p["lat"]))
    radius_3857 = p["radius_m"] / max(cos_lat, 0.15) * 1.2
    return {
        "center_lon": p["lon"],
        "center_lat": p["lat"],
        "radius_m_3857": radius_3857,
    }


# types of osm highways traversable by pedestrians according to osm so we can map cutthroughs too
PATH_KINDS = (
    "footway",
    "path",
    "pedestrian",
    "cycleway",
    "track",
    "bridleway",
    "corridor",
)
STAIR_KINDS = ("steps",)
MINOR_ROAD_KINDS = (
    "residential",
    "service",
    "unclassified",
    "living_street",
    "road",
)

WALKABLE_HIGHWAYS = PATH_KINDS + STAIR_KINDS + MINOR_ROAD_KINDS

# frozenset copies for fast `in` checks on the hot paths (graph build + bridging)
_PATH_SET = frozenset(PATH_KINDS)
_STAIR_SET = frozenset(STAIR_KINDS)
_ROAD_SET = frozenset(MINOR_ROAD_KINDS)

# ~4.3 km/h for speed estimate in m/s, surely this is too slow but this is what google gave me
WALKING_SPEED_MPS = 1.2

# weight multipliers for stairs, so flatter paths are preferred
STAIRS_WEIGHT_MULT = 1.6
# bias toward footpaths when a parallel minor road is also present
MINOR_ROAD_WEIGHT_MULT = 1.5

# max gap to bridge when a dangling path sits near another node
CROSSING_SNAP_M = 10.0

# how far from a road junction we can splice into a nearby path for hopping across
JUNCTION_CROSSING_M = 18.0

# weight multiplier for hopping across road junctions
CROSSING_WEIGHT_MULT = 1.2

# round to ~1cm precision (7 decimal degrees ~= 1.1 cm at the equator)
COORD_ROUND = 7


# -----------------------------------------------------------------------------
# geometry helpers
# -----------------------------------------------------------------------------


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in meters between two (lon, lat) points."""
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6_371_008.8  # mean earth radius, m
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    h = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def _node_key(lon: float, lat: float) -> tuple[float, float]:
    return (round(lon, COORD_ROUND), round(lat, COORD_ROUND))


_METRES_PER_DEG_LAT = 111_320.0


def _project_on_segment(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
) -> tuple[tuple[float, float], float, float]:
    """
    project (lon,lat) point p onto segment a->b.

    returns (projected_point, distance_m_from_p_to_projection, t in [0,1]).
    locally equirectangular — fine for the short distances we snap across.
    """
    mid_lat_rad = math.radians((a[1] + b[1] + p[1]) / 3.0)
    kx = math.cos(mid_lat_rad) * _METRES_PER_DEG_LAT
    ky = _METRES_PER_DEG_LAT
    ax = (p[0] - a[0]) * kx
    ay = (p[1] - a[1]) * ky
    bx = (b[0] - a[0]) * kx
    by = (b[1] - a[1]) * ky
    ab2 = bx * bx + by * by
    if ab2 <= 1e-9:
        return a, haversine_m(p, a), 0.0
    t = (ax * bx + ay * by) / ab2
    t = max(0.0, min(1.0, t))
    proj = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return proj, haversine_m(p, proj), t


# -----------------------------------------------------------------------------
# graph build
# -----------------------------------------------------------------------------


_GRAPH_LOCK = threading.Lock()
_GRAPH: nx.Graph | None = None
# Parallel numpy arrays built once from _GRAPH nodes for O(1)-ish snapping.
# Shape: (N, 2) float64 — columns are [lon, lat].
_NODE_ARRAY: np.ndarray | None = None
_NODE_LIST: list[tuple[float, float]] | None = None


def _ways_sql() -> "text":
    # Built at call time so the area filter picks up the current env
    # (pytest / reloads can change it between builds).
    return text(
        """
        SELECT osm_id,
               highway,
               name,
               ST_AsGeoJSON(ST_Transform(way, 4326)) AS geom
        FROM planet_osm_line
        WHERE highway = ANY(:kinds)
          AND ST_GeometryType(way) = 'ST_LineString'
        """
        + area_filter_sql()
    )


def _iter_segments(coords: Sequence[Sequence[float]]):
    """Yield (pt_a, pt_b) pairs for each adjacent pair of coords."""
    prev = None
    for c in coords:
        if len(c) < 2:
            continue
        lon, lat = float(c[0]), float(c[1])
        cur = (lon, lat)
        if prev is not None:
            yield prev, cur
        prev = cur


def _edge_weight(kind: str, length_m: float) -> float:
    if kind in _STAIR_SET:
        return length_m * STAIRS_WEIGHT_MULT
    if kind in _ROAD_SET:
        return length_m * MINOR_ROAD_WEIGHT_MULT
    return length_m


def _add_crossing_edge(
    g: nx.Graph,
    a: tuple[float, float],
    b: tuple[float, float],
    distance_m: float,
) -> None:
    """
    add a synthetic 'just walk across' connector. used by both bridging passes.
    no name / osm_id because it's not an osm feature, just an inferred link.
    """
    g.add_edge(
        a, b,
        length_m=distance_m,
        weight=distance_m * CROSSING_WEIGHT_MULT,
        kind="crossing",
        name=None,
        osm_id=None,
    )


def _splice_path_edge(
    g: nx.Graph,
    u: tuple[float, float],
    v: tuple[float, float],
    kind: str,
    name: str | None,
    osm_id: int | None,
    new_node: tuple[float, float],
) -> None:
    """
    split path edge (u,v) at new_node, inserting two sub-edges that
    inherit kind/name/osm_id. no-op if new_node coincides with u or v.
    caller is responsible for removing (u, v) first.
    """
    for endpoint in (u, v):
        length = haversine_m(endpoint, new_node)
        if length <= 0:
            continue
        g.add_edge(
            endpoint, new_node,
            length_m=length,
            weight=_edge_weight(kind, length),
            kind=kind,
            name=name,
            osm_id=osm_id,
        )


def _incident_kinds(g: nx.Graph) -> dict[tuple[float, float], set[str]]:
    """
    map every node to the set of highway kinds on its incident edges.
    one O(E) pass shared by both bridging passes.
    """
    out: dict[tuple[float, float], set[str]] = {}
    for u, v, data in g.edges(data=True):
        k = data.get("kind") or "path"
        out.setdefault(u, set()).add(k)
        out.setdefault(v, set()).add(k)
    return out


def build_graph() -> nx.Graph:
    """
    query every walkable osm line and assemble undirected graph
    nodes are (lon, lat) tuples rounded to COORD_ROUND decimals
    """
    g = nx.Graph()
    params = {"kinds": list(WALKABLE_HIGHWAYS), **area_filter_params()}
    t0 = time.perf_counter()
    try:
        rows = db.session.execute(_ways_sql(), params).mappings().all()
    except SQLAlchemyError:
        # table missing or transient db error gives empty graph
        db.session.rollback()
        return g
    _log.info("routing graph: %d ways fetched in %.2fs", len(rows), time.perf_counter() - t0)

    t1 = time.perf_counter()
    for row in rows:
        geom = row["geom"]
        if not geom:
            continue
        try:
            gj = json.loads(geom)
        except ValueError:
            continue
        if gj.get("type") != "LineString":
            continue
        kind = row["highway"] or "path"
        name = row["name"]
        osm_id = row["osm_id"]
        for a, b in _iter_segments(gj.get("coordinates") or []):
            ka = _node_key(*a)
            kb = _node_key(*b)
            if ka == kb:
                continue
            length = haversine_m(a, b)
            if length <= 0:
                continue
            weight = _edge_weight(kind, length)
            existing = g.get_edge_data(ka, kb)
            if existing and existing.get("weight", math.inf) <= weight:
                continue
            g.add_edge(
                ka,
                kb,
                length_m=length,
                weight=weight,
                kind=kind,
                name=name,
                osm_id=osm_id,
            )
    _log.info("routing graph: %d nodes, %d edges built in %.2fs",
              g.number_of_nodes(), g.number_of_edges(), time.perf_counter() - t1)

    t2 = time.perf_counter()
    _bridge_road_junctions_to_paths(g)
    _log.info("routing graph: junction bridging done in %.2fs", time.perf_counter() - t2)

    t3 = time.perf_counter()
    _bridge_dangling_path_ends(g)
    _log.info("routing graph: dangling bridging done in %.2fs", time.perf_counter() - t3)

    _log.info("routing graph: total build %.2fs, final %d nodes %d edges",
              time.perf_counter() - t0, g.number_of_nodes(), g.number_of_edges())
    return g



def _build_path_edge_grid(
    path_edges: list,
) -> tuple[dict, float]:
    """Bucket path edges into a spatial grid keyed by (cx, cy) cell index.

    Each edge is placed in every cell its bounding box touches (plus one cell
    margin).  At query time we check only the 9 cells around the junction so
    we inspect O(local_edges) instead of O(all_path_edges).

    Cell size is ~2× JUNCTION_CROSSING_M so a single-cell neighbourhood always
    covers the full snap radius.
    """
    from collections import defaultdict
    # ~40 m cells: each 3×3 neighbourhood covers ±60 m, well beyond 18 m snap.
    cell_deg = max(JUNCTION_CROSSING_M * 2 / _METRES_PER_DEG_LAT, 0.0003)
    grid: dict = defaultdict(list)
    for edge in path_edges:
        u, v, *_ = edge
        cx_min = int(min(u[0], v[0]) / cell_deg) - 1
        cx_max = int(max(u[0], v[0]) / cell_deg) + 1
        cy_min = int(min(u[1], v[1]) / cell_deg) - 1
        cy_max = int(max(u[1], v[1]) / cell_deg) + 1
        for cx in range(cx_min, cx_max + 1):
            for cy in range(cy_min, cy_max + 1):
                grid[(cx, cy)].append(edge)
    return grid, cell_deg


def _bridge_road_junctions_to_paths(g: nx.Graph) -> int:
    """
    At every minor-road junction, splice short connectors to nearby paths so
    the router can hop across intersections.

    Uses a spatial grid so each junction only inspects the ~5-20 path edges in
    its immediate vicinity rather than all path edges in the graph.  This makes
    the pass O(J × local_edges) ≈ O(J × 10) instead of O(J × E_path).
    """
    if g.number_of_nodes() == 0:
        return 0

    # Compute road-degree per node in a single O(E) pass.
    road_degree: dict[tuple[float, float], int] = {}
    for u, v, d in g.edges(data=True):
        if (d.get("kind") or "") in _ROAD_SET:
            road_degree[u] = road_degree.get(u, 0) + 1
            road_degree[v] = road_degree.get(v, 0) + 1

    junctions = [n for n, deg in road_degree.items() if deg >= 2]
    if not junctions:
        return 0

    # Build path edges once, then index them spatially.
    path_edges = [
        (u, v, d.get("kind") or "path", d.get("name"), d.get("osm_id"))
        for u, v, d in g.edges(data=True)
        if (d.get("kind") or "") in _PATH_SET
    ]
    if not path_edges:
        return 0

    grid, cell_deg = _build_path_edge_grid(path_edges)

    added = 0
    for jn in junctions:
        lon, lat = jn
        cx = int(lon / cell_deg)
        cy = int(lat / cell_deg)

        # Collect candidate edges from the 3×3 neighbourhood (deduplicated).
        seen_edge_ids: set[int] = set()
        local_edges = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for edge in grid.get((cx + dx, cy + dy), ()):
                    eid = id(edge)
                    if eid not in seen_edge_ids:
                        seen_edge_ids.add(eid)
                        local_edges.append(edge)

        if not local_edges:
            continue

        seen_targets: set[tuple[float, float]] = set()
        for u, v, kind, name, osm_id in local_edges:
            proj, dist, _t = _project_on_segment(jn, u, v)
            if dist > JUNCTION_CROSSING_M:
                continue
            node = _node_key(*proj)
            if node == jn or node in seen_targets:
                continue
            if g.has_edge(jn, node):
                seen_targets.add(node)
                continue
            if node != u and node != v and g.has_edge(u, v):
                g.remove_edge(u, v)
                _splice_path_edge(g, u, v, kind, name, osm_id, node)
            _add_crossing_edge(g, jn, node, dist)
            seen_targets.add(node)
            added += 1
    return added


def _bridge_dangling_path_ends(g: nx.Graph) -> int:
    """
    Stitch path-only degree-1 endpoints onto the nearest nearby node.

    Uses numpy masking: for each dangling endpoint broadcast a distance
    computation over all nodes, then mask to CROSSING_SNAP_M.  Because
    CROSSING_SNAP_M is only 10 m and the extract spans kilometres, the mask
    is almost always empty so the per-node inner loop is nearly never entered.
    """
    if g.number_of_nodes() == 0:
        return 0

    incident = _incident_kinds(g)
    dangling = [
        n for n in g.nodes
        if g.degree(n) == 1 and incident.get(n, set()) <= _PATH_SET
    ]
    if not dangling:
        return 0

    all_nodes: list[tuple[float, float]] = list(g.nodes)
    node_arr = np.array(all_nodes, dtype=np.float64)  # (N, 2)
    thresh2 = CROSSING_SNAP_M * CROSSING_SNAP_M

    added = 0
    for end in dangling:
        lon, lat = end
        cos_lat = math.cos(math.radians(lat))
        dlon = (node_arr[:, 0] - lon) * cos_lat * _METRES_PER_DEG_LAT
        dlat = (node_arr[:, 1] - lat) * _METRES_PER_DEG_LAT
        dists2 = dlon * dlon + dlat * dlat

        # Fast exit: nothing within snap radius (the common case).
        nearby_idx = np.where(dists2 <= thresh2)[0]
        if nearby_idx.size == 0:
            continue

        exclude: set[tuple[float, float]] = {end}
        exclude.update(g.neighbors(end))

        best: tuple[float, float] | None = None
        best_d = math.inf
        for idx in nearby_idx:
            n = all_nodes[int(idx)]
            if n in exclude:
                continue
            d = math.sqrt(float(dists2[idx]))
            if d < best_d:
                best, best_d = n, d

        if best is None:
            continue
        _add_crossing_edge(g, end, best, best_d)
        added += 1
    return added


def _build_node_index(g: nx.Graph) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """Build a (N,2) float64 array and parallel node list from graph nodes.

    Used to vectorise nearest-node queries: instead of a Python loop over every
    node we broadcast a single numpy subtraction across the whole array and call
    argmin — roughly 100× faster for the graph sizes we deal with.
    """
    nodes: list[tuple[float, float]] = list(g.nodes)
    arr = np.array(nodes, dtype=np.float64)  # shape (N, 2): col-0 lon, col-1 lat
    return arr, nodes


def get_graph() -> nx.Graph:
    """Return the cached graph, building it on first use.

    If the warm-up background thread is still building the graph (lock held),
    raises RoutingError so the HTTP layer can return a 503 immediately rather
    than blocking the request thread until the browser times out.
    """
    global _GRAPH, _NODE_ARRAY, _NODE_LIST
    if _GRAPH is not None:
        return _GRAPH
    acquired = _GRAPH_LOCK.acquire(blocking=False)
    if not acquired:
        # Another thread is currently building the graph; tell the caller
        # to retry instead of blocking for potentially tens of seconds.
        raise RoutingError("route graph is still loading — please retry in a moment")
    try:
        if _GRAPH is None:
            g = build_graph()
            arr, nodes = _build_node_index(g)
            _GRAPH = g
            _NODE_ARRAY = arr
            _NODE_LIST = nodes
    finally:
        _GRAPH_LOCK.release()
    return _GRAPH


def reset_graph_cache() -> None:
    """Drop the in-memory graph so the next call rebuilds from the DB."""
    global _GRAPH, _NODE_ARRAY, _NODE_LIST
    with _GRAPH_LOCK:
        _GRAPH = None
        _NODE_ARRAY = None
        _NODE_LIST = None


def warm_cache_async(app) -> None:
    """Kick off a background thread that builds the route graph.

    The first real /api/route call is cheap because the graph is
    already in memory. We swallow any exception inside the thread so a
    DB hiccup at boot doesn't crash the app; the next on-demand
    get_graph() will try again.
    """
    if _GRAPH is not None:
        return

    def _run():
        try:
            with app.app_context():
                get_graph()
        except Exception:  # noqa: BLE001
            _log.exception("routing warm-up failed; will retry on first request")

    t = threading.Thread(target=_run, name="routing-warm", daemon=True)
    t.start()


# -----------------------------------------------------------------------------
# snap + route
# -----------------------------------------------------------------------------


class RoutingError(RuntimeError):
    """Raised when we can't produce a route for the given inputs."""


@dataclass
class Route:
    trackpoints: list[tuple[float, float]]  # (lon, lat)
    distance_m: float
    duration_s: float
    origin: tuple[float, float] | None = None
    destination: tuple[float, float] | None = None
    origin_label: str | None = None
    destination_label: str | None = None
    segments: list[dict] = field(default_factory=list)

    def to_geojson(self) -> dict:
        return {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [list(p) for p in self.trackpoints],
            },
            "properties": {
                "distance_m": self.distance_m,
                "duration_s": self.duration_s,
            },
        }


def _nearest_node(
    graph: nx.Graph, point: tuple[float, float]
) -> tuple[float, float]:
    """Return the graph node closest to *point* (lon, lat).

    Uses the module-level numpy arrays when they match the supplied graph
    (the common cached path).  Falls back to a pure-Python linear scan only
    when called with a one-off graph (e.g. in tests).

    Raises RoutingError if the graph is empty.
    """
    if graph.number_of_nodes() == 0:
        raise RoutingError("path network is empty; run scripts/load-osm.sh")

    # Fast path: vectorised numpy nearest-node using the cached index.
    if _NODE_ARRAY is not None and _NODE_LIST is not None and graph is _GRAPH:
        lon, lat = point
        # Equirectangular projection — accurate enough for snapping within a
        # few km; avoids the trig inside haversine for every node.
        cos_lat = math.cos(math.radians(lat))
        dlon = (_NODE_ARRAY[:, 0] - lon) * cos_lat * 111_320.0
        dlat = (_NODE_ARRAY[:, 1] - lat) * 111_320.0
        idx = int(np.argmin(dlon * dlon + dlat * dlat))
        return _NODE_LIST[idx]

    # Slow fallback: pure Python (used only for ad-hoc / test graphs).
    best: tuple[float, float] | None = None
    best_d = math.inf
    for n in graph.nodes:
        d = haversine_m(point, n)
        if d < best_d:
            best = n
            best_d = d
    assert best is not None
    return best


def _nearest_node_by_edge_kinds(
    graph: nx.Graph,
    point: tuple[float, float],
    allowed_kinds: set[str],
) -> tuple[float, float]:
    """Nearest node that has at least one incident edge of allowed kind."""
    best: tuple[float, float] | None = None
    best_d = math.inf
    for n in graph.nodes:
        has_allowed = False
        for _u, _v, data in graph.edges(n, data=True):
            if (data.get("kind") or "") in allowed_kinds:
                has_allowed = True
                break
        if not has_allowed:
            continue
        d = haversine_m(point, n)
        if d < best_d:
            best = n
            best_d = d
    if best is None:
        raise RoutingError("path network is empty; run scripts/load-osm.sh")
    return best


def shortest_path(
    src: tuple[float, float],
    dst: tuple[float, float],
    *,
    graph: nx.Graph | None = None,
    origin_label: str | None = None,
    destination_label: str | None = None,
) -> Route:
    """Shortest walkable path from src to dst as a Route.

    Both points are (lon, lat). They don't need to lie on the graph;
    we snap each to the nearest node and tack on a straight segment
    from/to the user's actual point so the rendered line reaches the
    asked location instead of stopping at the nearest sidewalk.
    """
    g = graph or get_graph()
    a = _nearest_node(g, src)
    b = _nearest_node(g, dst)
    if a == b:
        coords = [src, a, dst]
        d = haversine_m(src, a) + haversine_m(a, dst)
        return Route(
            trackpoints=coords,
            distance_m=d,
            duration_s=d / WALKING_SPEED_MPS,
            origin=src,
            destination=dst,
            origin_label=origin_label,
            destination_label=destination_label,
        )
    try:
        # A* with straight-line distance dramatically reduces explored nodes on
        # long cross-map routes while preserving optimality (all edge weights
        # are >= real metric distance, so this heuristic is admissible).
        nodes = nx.astar_path(
            g,
            a,
            b,
            heuristic=lambda n1, n2: haversine_m(n1, n2),
            weight="weight",
        )
    except nx.NetworkXNoPath:
        # Fallback: if nearest-node snap landed on disconnected path fragments,
        # retry by forcing both endpoints onto nodes that touch minor roads.
        # This keeps normal path-first behavior, but still finds routeable
        # road-only corridors when footpaths are absent or disconnected.
        try:
            a_road = _nearest_node_by_edge_kinds(g, src, _ROAD_SET)
            b_road = _nearest_node_by_edge_kinds(g, dst, _ROAD_SET)
            nodes = nx.astar_path(
                g,
                a_road,
                b_road,
                heuristic=lambda n1, n2: haversine_m(n1, n2),
                weight="weight",
            )
            a = a_road
            b = b_road
        except (nx.NetworkXNoPath, RoutingError) as road_err:
            raise RoutingError(
                "no path between the two points (graph is disconnected here)"
            ) from road_err
    except nx.NodeNotFound as err:
        raise RoutingError(str(err)) from err

    coords: list[tuple[float, float]] = [src, a]
    distance = haversine_m(src, a)
    for prev, cur in zip(nodes[:-1], nodes[1:]):
        edge = g.get_edge_data(prev, cur)
        distance += edge.get("length_m") or haversine_m(prev, cur)
        coords.append(cur)
    coords.append(dst)
    distance += haversine_m(b, dst)

    return Route(
        trackpoints=coords,
        distance_m=distance,
        duration_s=distance / WALKING_SPEED_MPS,
        origin=src,
        destination=dst,
        origin_label=origin_label,
        destination_label=destination_label,
    )


# -----------------------------------------------------------------------------
# gpx serialization (use gpxpy when expanding)
# -----------------------------------------------------------------------------


_GPX_NS = "http://www.topografix.com/GPX/1/1"


def route_to_gpx(route: Route, *, name: str | None = None) -> str:
    ET.register_namespace("", _GPX_NS)
    gpx = ET.Element(
        f"{{{_GPX_NS}}}gpx",
        {
            "version": "1.1",
            "creator": "maristmaps",
        },
    )

    meta = ET.SubElement(gpx, f"{{{_GPX_NS}}}metadata")
    ET.SubElement(meta, f"{{{_GPX_NS}}}name").text = name or "maristmaps route"
    ET.SubElement(meta, f"{{{_GPX_NS}}}time").text = (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )

    def _wpt(point: tuple[float, float] | None, label: str | None):
        if point is None:
            return
        lon, lat = point
        el = ET.SubElement(
            gpx,
            f"{{{_GPX_NS}}}wpt",
            {"lat": f"{lat:.7f}", "lon": f"{lon:.7f}"},
        )
        if label:
            ET.SubElement(el, f"{{{_GPX_NS}}}name").text = label

    _wpt(route.origin, route.origin_label or "Start")
    _wpt(route.destination, route.destination_label or "End")

    trk = ET.SubElement(gpx, f"{{{_GPX_NS}}}trk")
    ET.SubElement(trk, f"{{{_GPX_NS}}}name").text = name or "route"
    seg = ET.SubElement(trk, f"{{{_GPX_NS}}}trkseg")
    for lon, lat in route.trackpoints:
        ET.SubElement(
            seg,
            f"{{{_GPX_NS}}}trkpt",
            {"lat": f"{lat:.7f}", "lon": f"{lon:.7f}"},
        )

    ET.indent(gpx, space="  ")
    xml = ET.tostring(gpx, encoding="unicode", xml_declaration=True)
    return xml


def debug_stats(graph: nx.Graph | None = None) -> dict:
    g = graph or get_graph()
    by_kind: dict[str, int] = {}
    for _u, _v, data in g.edges(data=True):
        k = data.get("kind") or "path"
        by_kind[k] = by_kind.get(k, 0) + 1
    return {
        "nodes": g.number_of_nodes(),
        "edges": g.number_of_edges(),
        "components": nx.number_connected_components(g) if g.number_of_nodes() else 0,
        "edges_by_kind": by_kind,
    }
