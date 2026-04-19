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
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Sequence

import networkx as nx
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


_DEFAULT_CENTER_LON = -73.93446921913481
_DEFAULT_CENTER_LAT = 41.72233476143977
_DEFAULT_RADIUS_M = 1500.0


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
    """SQL fragment that clips a row's ``way`` column to the configured
    disc, or an empty string when filtering is disabled.

    Uses geography casts so the radius is in real meters regardless of
    the planet_osm_* table's projection.
    """
    if area_params()["radius_m"] <= 0:
        return ""
    return (
        " AND ST_DWithin("
        "ST_Transform(way, 4326)::geography, "
        "ST_SetSRID(ST_MakePoint(:center_lon, :center_lat), 4326)::geography, "
        ":radius_m)"
    )


def area_filter_params() -> dict:
    """Bind params for area_filter_sql() — empty when the filter is off."""
    p = area_params()
    if p["radius_m"] <= 0:
        return {}
    return {
        "center_lon": p["lon"],
        "center_lat": p["lat"],
        "radius_m": p["radius_m"],
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
    try:
        rows = db.session.execute(_ways_sql(), params).mappings().all()
    except SQLAlchemyError:
        # table missing or transient db error gives empty graph
        db.session.rollback()
        return g

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
            # if pair of nodes are already connected, keep cheaper option
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
    # order matters: junction bridging can create new path nodes (by
    # splicing segments) that then become candidates for endpoint bridging.
    _bridge_road_junctions_to_paths(g)
    _bridge_dangling_path_ends(g)
    return g


def _bridge_road_junctions_to_paths(g: nx.Graph) -> int:
    """
    returns the number of connector edges added.
    at every minor-road junction, splice short connectors to nearby path
    so router can hop across intersections, roads, etc. yes, this is pro-jaywalking.

    motivating case: the two paths and intersection at hancock.
    """
    if g.number_of_nodes() == 0:
        return 0

    def _road_degree(n: tuple[float, float]) -> int:
        return sum(
            1 for _u, _v, d in g.edges(n, data=True)
            if (d.get("kind") or "") in _ROAD_SET
        )

    junctions = [n for n in list(g.nodes) if _road_degree(n) >= 2]
    if not junctions:
        return 0

    added = 0
    for jn in junctions:
        # refetch each iteration so splits from earlier junctions are
        # visible (we might need to splice a sub-segment).
        path_edges = [
            (u, v, d.get("kind") or "path", d.get("name"), d.get("osm_id"))
            for u, v, d in g.edges(data=True)
            if (d.get("kind") or "") in _PATH_SET
        ]
        # a single junction can legitimately connect to several nearby
        # sidewalks (both sides of the road, plus the across-the-T one).
        # dedup by target node so we don't stack duplicate connectors.
        seen_targets: set[tuple[float, float]] = set()
        for u, v, kind, name, osm_id in path_edges:
            proj, dist, _t = _project_on_segment(jn, u, v)
            if dist > JUNCTION_CROSSING_M:
                continue
            node = _node_key(*proj)
            if node == jn or node in seen_targets:
                continue
            if g.has_edge(jn, node):
                seen_targets.add(node)
                continue
            # splice the path edge if we landed mid-segment.
            if node != u and node != v and g.has_edge(u, v):
                g.remove_edge(u, v)
                _splice_path_edge(g, u, v, kind, name, osm_id, node)
            _add_crossing_edge(g, jn, node, dist)
            seen_targets.add(node)
            added += 1
    return added


def _bridge_dangling_path_ends(g: nx.Graph) -> int:
    """
    stitch path-only degree-1 endpoints onto the nearest nearby node.
    catches sidewalks that stop just short of something they plainly
    connect to in real life. returns the number of edges added.
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

    all_nodes = list(g.nodes)
    added = 0
    for end in dangling:
        best = None
        best_d = CROSSING_SNAP_M
        for other in all_nodes:
            if other == end or g.has_edge(end, other):
                continue
            d = haversine_m(end, other)
            if d < best_d:
                best = other
                best_d = d
        if best is None:
            continue
        _add_crossing_edge(g, end, best, best_d)
        added += 1
    return added


def get_graph() -> nx.Graph:
    """Return the cached graph, building it lazily on first use."""
    global _GRAPH
    if _GRAPH is not None:
        return _GRAPH
    with _GRAPH_LOCK:
        if _GRAPH is None:
            _GRAPH = build_graph()
    return _GRAPH


def reset_graph_cache() -> None:
    """Drop the in-memory graph so the next call rebuilds from the DB."""
    global _GRAPH
    with _GRAPH_LOCK:
        _GRAPH = None


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
    """Linear-scan nearest graph node.

    Raises RoutingError if the graph is empty.
    """
    if graph.number_of_nodes() == 0:
        raise RoutingError("path network is empty; run scripts/load-osm.sh")
    best = None
    best_d = math.inf
    for n in graph.nodes:
        d = haversine_m(point, n)
        if d < best_d:
            best = n
            best_d = d
    assert best is not None
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
        nodes = nx.shortest_path(g, a, b, weight="weight")
    except nx.NetworkXNoPath as err:
        raise RoutingError(
            "no path between the two points (graph is disconnected here)"
        ) from err
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
