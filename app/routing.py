"""
inter-building routing over campus paths
end-to-end so the rest has something to plug into, should be extensible to the intra-building routing

build_graph() -> nx.Graph of every walkable osm way on campus (does include roads)
shortest_path(src, dst) -> route with trackpoints + distance + duration
route_to_gpx(route) -> gpx 1.1 xml string suitable for download (we should use gpxpy for this)

campus is small enough that networkx is fast enough for this, which is nice since gpx is xml
edges are weighted by haversine distance in metres, there is a penalty for stairs and roads, so paths are preferred
coordinates are (lon, lat) in espg:4326 which matches geojson and maplibre
"""

from __future__ import annotations

import json
import math
import threading
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Sequence

import networkx as nx
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.extensions import db


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

# ~4.3 km/h for speed estimate in m/s, surely this is too slow but this is what google gave me
WALKING_SPEED_MPS = 1.2

# weight multipliers for stairs, so flatter paths are preferred
STAIRS_WEIGHT_MULT = 1.6

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


# -----------------------------------------------------------------------------
# graph build
# -----------------------------------------------------------------------------


_GRAPH_LOCK = threading.Lock()
_GRAPH: nx.Graph | None = None


_WAYS_SQL = text(
    """
    SELECT osm_id,
           highway,
           name,
           ST_AsGeoJSON(ST_Transform(way, 4326)) AS geom
    FROM planet_osm_line
    WHERE highway = ANY(:kinds)
      AND ST_GeometryType(way) = 'ST_LineString'
    """
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
    if kind in STAIR_KINDS:
        return length_m * STAIRS_WEIGHT_MULT
    return length_m


def build_graph() -> nx.Graph:
    """
    query every walkable osm line and assemble undirected graph
    nodes are (lon, lat) tuples rounded to COORD_ROUND decimals
    """
    g = nx.Graph()
    try:
        rows = db.session.execute(
            _WAYS_SQL, {"kinds": list(WALKABLE_HIGHWAYS)}
        ).mappings().all()
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
    return g


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
    return {
        "nodes": g.number_of_nodes(),
        "edges": g.number_of_edges(),
        "components": nx.number_connected_components(g) if g.number_of_nodes() else 0,
    }
