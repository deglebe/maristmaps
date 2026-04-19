"""
Works by using our I* optimized pathing
        1. compute path using hallways from start to end ignoring floor
        2. find a stairway/elevator (connector) along route that goes to needed floors
        3. if there is a connector use it
        4. if not pick the closest connector to one of the points
        5. route by connecting points to relevant hallways

"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


# --- constants ---------------------------------------------------------------

METERS_PER_FLOOR = 20.0           # vertical cost per floor (matches user perception)
ON_ROUTE_THRESHOLD_M = 20.0       # i*op step 2: connector proximity to flat route
START_LEG_WEIGHT = 1.0            # i*op step 4: weighted-distance coefficients
END_LEG_WEIGHT = 1.75             # end-weighted — prefer dropping near destination

STRAIGHT_THRESHOLD_DEG = 35.0     # turn bucketing
BACK_THRESHOLD_DEG = 150.0

METERS_TO_FEET = 3.28084
WALKING_SPEED_MPS = 1.2           # matches app/routing.py


# --- data types --------------------------------------------------------------

# (lon, lat) tuples throughout — matches geojson, maplibre, app/routing.py.
Point = tuple[float, float]


@dataclass
class LocationRow:
    """lightweight dataclass mirror of a row from the locations table."""
    id: int
    kind: str                       # 'room' | 'entrance' | 'connector' | 'hallway'
    subtype: str | None             # 'stairs' | 'elevator' for connectors
    orientation: str | None         # N/NE/E/SE/S/SW/W/NW for entrances
    building: str
    floor: str                      # '1', '0-3', '*'
    room: str | None
    notes: str | None
    closest_entrance: str | None
    closest_entrance_elevator: str | None
    closest_stair: str | None
    closest_elevator: str | None
    direction_from_connector: str | None
    connections: str | None         # 'H2,H3' comma-separated hallway room ids
    lon: float
    lat: float

    @property
    def point(self) -> Point:
        return (self.lon, self.lat)


@dataclass
class Step:
    kind: str
    text: str
    polyline: list[Point] = field(default_factory=list)
    distance_m: float | None = None
    connector_name: str | None = None
    connector_kind: str | None = None      # 'stairs' | 'elevator'
    from_floor: int | None = None
    to_floor: int | None = None
    turn: str | None = None                # 'left' | 'right' | 'straight' | 'back'


STEP_KINDS = frozenset({
    "start_at_room",
    "exit_room",
    "enter_building",
    "exit_building",
    "walk_to_connector",
    "walk_to_entrance",
    "walk_to_room",
    "change_floor",
    "exit_connector",
    "arrive",
})


@dataclass
class RoutePhase:
    kind: str                       # 'indoor' (always, in this module)
    building: str | None
    polyline: list[Point]
    steps: list[Step]
    distance_m: float
    duration_s: float
    error: str | None = None

    # i*op diagnostics (surface in ui as summary-line badges)
    connector_used: str | None = None
    connector_kind: str | None = None
    from_floor: int | None = None
    to_floor: int | None = None
    used_fallback: bool = False
    on_route_connector: bool = False


# --- geometry ----------------------------------------------------------------


def haversine_m(a: Point, b: Point) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(h))


def bearing_deg(a: Point, b: Point) -> float:
    """initial bearing from a to b in degrees (0=N, 90=E, 180=S, 270=W)."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def turn_classify(from_bearing: float, to_bearing: float) -> str:
    delta = ((to_bearing - from_bearing + 540.0) % 360.0) - 180.0  # [-180, 180]
    if abs(delta) < STRAIGHT_THRESHOLD_DEG:
        return "straight"
    if abs(delta) > BACK_THRESHOLD_DEG:
        return "back"
    return "left" if delta > 0 else "right" # change this line if you need to change directional directions!


def project_point_on_segment(
    p: Point, a: Point, b: Point
) -> tuple[Point, float, float]:
    """returns (closest_point_on_segment, t_in_[0,1], perpendicular_distance_m).

    local equirectangular math — centimeter-accurate at building scale.
    """
    m_per_lat = 111_320.0
    m_per_lon = 111_320.0 * math.cos(math.radians(p[1]))
    px, py = p[0] * m_per_lon, p[1] * m_per_lat
    ax, ay = a[0] * m_per_lon, a[1] * m_per_lat
    bx, by = b[0] * m_per_lon, b[1] * m_per_lat
    dx, dy = bx - ax, by - ay
    len_sq = dx * dx + dy * dy
    if len_sq == 0.0:
        return a, 0.0, math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
    proj_x, proj_y = ax + t * dx, ay + t * dy
    proj = (proj_x / m_per_lon, proj_y / m_per_lat)
    return proj, t, math.hypot(px - proj_x, py - proj_y)


def polyline_length_m(points: list[Point]) -> float:
    return sum(haversine_m(points[i - 1], points[i]) for i in range(1, len(points)))


def point_to_polyline_m(p: Point, points: list[Point]) -> float:
    if len(points) < 2:
        return math.inf
    best = math.inf
    for i in range(1, len(points)):
        _, _, d = project_point_on_segment(p, points[i - 1], points[i])
        if d < best:
            best = d
    return best


# --- floors ------------------------------------------------------------------


def _range_match(s: str) -> tuple[int, int] | None:
    """parse '0-3' (or '0–3' with em-dash) into (0, 3)."""
    s = s.replace("–", "-").strip()
    if "-" not in s:
        return None
    parts = s.split("-")
    if len(parts) != 2:
        return None
    try:
        return int(parts[0]), int(parts[1])
    except ValueError:
        return None


def _all_building_floors(
    locations: list[LocationRow], building: str
) -> list[str]:
    # skip hallway rows so '*' expansion doesn't recurse through them
    floors: set[str] = set()
    for e in locations:
        if e.building != building or e.kind == "hallway":
            continue
        f = (e.floor or "").replace("–", "-").strip()
        if not f or f in ("—", "*"):
            continue
        m = _range_match(f)
        if m:
            a, b = m
            for i in range(min(a, b), max(a, b) + 1):
                floors.add(str(i))
        else:
            floors.add(f)
    return list(floors)


def expand_floors(
    e: LocationRow, locations: list[LocationRow]
) -> list[str]:
    f = (e.floor or "").replace("–", "-").strip()
    if not f or f == "—":
        return []
    if f == "*":
        return _all_building_floors(locations, e.building)
    m = _range_match(f)
    if m:
        a, b = m
        return [str(i) for i in range(min(a, b), max(a, b) + 1)]
    return [f]


def parse_floor_min(
    e: LocationRow, locations: list[LocationRow]
) -> int | None:
    for f in expand_floors(e, locations):
        try:
            return int(f)
        except ValueError:
            continue
    return None


def connector_reaches(
    c: LocationRow, floor: int, locations: list[LocationRow]
) -> bool:
    return str(floor) in expand_floors(c, locations)


# --- hallway graph -----------------------------------------------------------


def hallway_nodes_on_floor(
    locations: list[LocationRow], building: str, floor: int
) -> list[LocationRow]:
    return [
        e for e in locations
        if e.kind == "hallway"
        and e.building == building
        and str(floor) in expand_floors(e, locations)
    ]


@dataclass
class HallwayGraph:
    nodes: list[LocationRow]
    edges: dict[int, list[tuple[LocationRow, float]]]  # node_id -> [(neighbor, cost_m)]
    by_room: dict[str, LocationRow]


def build_hallway_graph(
    locations: list[LocationRow], building: str, floor: int
) -> HallwayGraph:
    nodes = hallway_nodes_on_floor(locations, building, floor)
    by_room: dict[str, LocationRow] = {n.room: n for n in nodes if n.room}
    edges: dict[int, list[tuple[LocationRow, float]]] = {n.id: [] for n in nodes}
    for n in nodes:
        for raw in (n.connections or "").split(","):
            room_id = raw.strip()
            if not room_id:
                continue
            tgt = by_room.get(room_id)
            if tgt is None:
                continue
            edges[n.id].append((tgt, haversine_m(n.point, tgt.point)))
    return HallwayGraph(nodes=nodes, edges=edges, by_room=by_room)


@dataclass
class EdgeProjection:
    from_node: LocationRow
    to_node: LocationRow
    point: Point
    t: float
    dist_m: float


def nearest_hallway_edge(
    pos: Point, graph: HallwayGraph
) -> EdgeProjection | None:
    if len(graph.nodes) < 2:
        return None
    best: EdgeProjection | None = None
    seen: set[tuple[int, int]] = set()
    for n in graph.nodes:
        for (tgt, _cost) in graph.edges.get(n.id, []):
            key = (min(n.id, tgt.id), max(n.id, tgt.id))
            if key in seen:
                continue
            seen.add(key)
            proj, t, d = project_point_on_segment(pos, n.point, tgt.point)
            if best is None or d < best.dist_m:
                best = EdgeProjection(
                    from_node=n, to_node=tgt, point=proj, t=t, dist_m=d
                )
    return best


# --- dijkstra ----------------------------------------------------------------


def dijkstra(
    graph: HallwayGraph, source: LocationRow, target: LocationRow
) -> list[LocationRow] | None:
    """o(n²) — fine for indoor graphs (tens of nodes)."""
    if source.id == target.id:
        return [source]
    by_id: dict[int, LocationRow] = {n.id: n for n in graph.nodes}
    dist: dict[int, float] = {n.id: math.inf for n in graph.nodes}
    prev: dict[int, LocationRow] = {}
    visited: set[int] = set()
    dist[source.id] = 0.0

    while True:
        u_id, u_dist = None, math.inf
        for nid, d in dist.items():
            if nid in visited:
                continue
            if d < u_dist:
                u_dist, u_id = d, nid
        if u_id is None or u_dist == math.inf:
            break
        if u_id == target.id:
            break
        visited.add(u_id)
        for (nbr, cost) in graph.edges.get(u_id, []):
            if nbr.id in visited:
                continue
            alt = u_dist + cost
            if alt < dist[nbr.id]:
                dist[nbr.id] = alt
                prev[nbr.id] = by_id[u_id]

    if target.id not in prev and source.id != target.id:
        return None
    path: list[LocationRow] = [target]
    cur = target
    while cur.id in prev:
        cur = prev[cur.id]
        path.insert(0, cur)
    return path


# --- one-floor legs ----------------------------------------------------------


def route_leg_on_floor(
    from_pt: Point,
    to_pt: Point,
    building: str,
    floor: int,
    locations: list[LocationRow],
) -> list[Point]:
    """polyline from from_pt to to_pt on one floor.

    endpoints project perpendicularly onto the nearest hallway edges rather
    than snapping to the nearest nodes. falls back to a straight line when
    no hallway graph is available.
    """
    graph = build_hallway_graph(locations, building, floor)
    if len(graph.nodes) < 2:
        return [from_pt, to_pt]

    start_edge = nearest_hallway_edge(from_pt, graph)
    end_edge = nearest_hallway_edge(to_pt, graph)
    if not start_edge or not end_edge:
        return [from_pt, to_pt]

    same_edge = (
        {start_edge.from_node.id, start_edge.to_node.id}
        == {end_edge.from_node.id, end_edge.to_node.id}
    )
    if same_edge:
        return [from_pt, start_edge.point, end_edge.point, to_pt]

    # try every endpoint pairing; pick the shortest total
    options = [
        (start_edge.from_node, end_edge.from_node),
        (start_edge.from_node, end_edge.to_node),
        (start_edge.to_node, end_edge.from_node),
        (start_edge.to_node, end_edge.to_node),
    ]
    best_path: list[LocationRow] | None = None
    best_cost = math.inf
    for (s, e) in options:
        path = dijkstra(graph, s, e)
        if path is None:
            continue
        cost = haversine_m(start_edge.point, s.point)
        cost += sum(
            haversine_m(path[i - 1].point, path[i].point)
            for i in range(1, len(path))
        )
        cost += haversine_m(e.point, end_edge.point)
        if cost < best_cost:
            best_cost, best_path = cost, path

    if best_path is None:
        return [from_pt, to_pt]

    pts: list[Point] = [from_pt, start_edge.point]
    pts.extend(n.point for n in best_path)
    pts.extend([end_edge.point, to_pt])
    return pts


# --- connector selection -----------------------------------------------------


def pick_best_connector(
    start: LocationRow,
    end: LocationRow,
    subtype: str,
    locations: list[LocationRow],
) -> LocationRow | None:
    sf = parse_floor_min(start, locations)
    ef = parse_floor_min(end, locations)
    if sf is None or ef is None:
        return None
    best, best_cost = None, math.inf
    for c in locations:
        if (
            c.kind != "connector"
            or c.subtype != subtype
            or c.building != start.building
            or not connector_reaches(c, sf, locations)
            or not connector_reaches(c, ef, locations)
        ):
            continue
        d_start = haversine_m(start.point, c.point)
        d_end = haversine_m(c.point, end.point)
        cost = START_LEG_WEIGHT * d_start + END_LEG_WEIGHT * d_end
        if cost < best_cost:
            best_cost, best = cost, c
    return best


def connector_on_route(
    polyline: list[Point],
    start: LocationRow,
    end: LocationRow,
    subtype: str,
    locations: list[LocationRow],
) -> LocationRow | None:
    sf = parse_floor_min(start, locations)
    ef = parse_floor_min(end, locations)
    if sf is None or ef is None:
        return None
    best, best_d = None, math.inf
    for c in locations:
        if (
            c.kind != "connector"
            or c.subtype != subtype
            or c.building != start.building
            or not connector_reaches(c, sf, locations)
            or not connector_reaches(c, ef, locations)
        ):
            continue
        d = point_to_polyline_m(c.point, polyline)
        if d <= ON_ROUTE_THRESHOLD_M and d < best_d:
            best_d, best = d, c
    return best


# --- text formatting ---------------------------------------------------------


def format_distance(meters: float) -> str:
    if meters < 1.5:
        return "a few feet"
    ft = round(meters * METERS_TO_FEET)
    ft_rounded = 5 * round(ft / 5) if ft >= 10 else ft
    return f"about {ft_rounded} feet ({round(meters)} m)"


def _turn_into_hallway(turn: str) -> str:
    return {
        "left": "turn left into the hallway",
        "right": "turn right into the hallway",
        "straight": "continue straight into the hallway",
        "back": "turn around — the hallway is behind you",
    }[turn]


def _arrival_side(turn: str) -> str:
    return {
        "left": "on your left",
        "right": "on your right",
        "straight": "straight ahead",
        "back": "behind you",
    }[turn]


# --- step emitters -----------------------------------------------------------


def _step_start_at_room(start: LocationRow) -> Step:
    return Step(
        kind="start_at_room",
        text=f"Start at room {start.room}.",
        polyline=[start.point],
    )


def _step_enter_building(entrance: LocationRow) -> Step:
    name = entrance.room or "the entrance"
    orient = f" on the {entrance.orientation} side" if entrance.orientation else ""
    return Step(
        kind="enter_building",
        text=f"Enter {entrance.building} through {name}{orient}.",
        polyline=[entrance.point],
    )


def _step_exit_room(start: LocationRow, leg: list[Point]) -> Step:
    # geometric turn detection when we have room, hallway entry, and a next waypoint
    if len(leg) < 3:
        return Step(
            kind="exit_room",
            text=f"Exit {start.room} into the hallway.",
            polyline=leg[:2],
        )
    exit_bearing = bearing_deg(leg[0], leg[1])
    hallway_bearing = bearing_deg(leg[1], leg[2])
    turn = turn_classify(exit_bearing, hallway_bearing)
    return Step(
        kind="exit_room",
        text=f"Exit {start.room} and {_turn_into_hallway(turn)}.",
        polyline=leg[:2],
        turn=turn,
    )


def _step_walk(kind: str, target_name: str, polyline: list[Point]) -> Step:
    dist = polyline_length_m(polyline)
    return Step(
        kind=kind,
        text=f"Walk to {target_name} ({format_distance(dist)}).",
        polyline=polyline,
        distance_m=dist,
    )


def _step_change_floor(
    connector: LocationRow, from_f: int, to_f: int
) -> Step:
    direction = "up" if to_f > from_f else "down"
    name = connector.room or (
        "the stairs" if connector.subtype == "stairs" else "the elevator"
    )
    return Step(
        kind="change_floor",
        text=f"Take {name} {direction} to floor {to_f}.",
        polyline=[connector.point],
        connector_name=connector.room,
        connector_kind=connector.subtype,
        from_floor=from_f,
        to_floor=to_f,
    )


def _step_exit_connector(connector: LocationRow) -> Step:
    # inline direction_from_connector verbatim if present; sentence-case + period
    custom = (connector.direction_from_connector or "").strip()
    if custom:
        if custom[0].islower():
            custom = custom[0].upper() + custom[1:]
        if not custom.endswith("."):
            custom = custom + "."
        text = f"Exit {connector.room or 'the stairwell'}. {custom}"
    else:
        kind = "stairwell" if connector.subtype == "stairs" else "elevator"
        text = f"Exit the {kind}."
    return Step(
        kind="exit_connector",
        text=text,
        polyline=[connector.point],
        connector_name=connector.room,
        connector_kind=connector.subtype,
    )


def _step_arrive_at_room(end: LocationRow, leg: list[Point]) -> Step:
    name = end.room or "your destination"
    if len(leg) >= 3:
        n = len(leg)
        approach = bearing_deg(leg[n - 3], leg[n - 2])
        into_room = bearing_deg(leg[n - 2], leg[n - 1])
        turn = turn_classify(approach, into_room)
        return Step(
            kind="arrive",
            text=f"You've arrived at {name} ({_arrival_side(turn)}).",
            polyline=[end.point],
            turn=turn,
        )
    return Step(
        kind="arrive",
        text=f"You've arrived at {name}.",
        polyline=[end.point],
    )


def _step_exit_building(entrance: LocationRow) -> Step:
    name = entrance.room or "the entrance"
    orient = f" on the {entrance.orientation} side" if entrance.orientation else ""
    return Step(
        kind="exit_building",
        text=f"Exit {entrance.building} through {name}{orient}.",
        polyline=[entrance.point],
    )


# --- shared indoor router ----------------------------------------------------


def _route_indoor(
    start: LocationRow,
    end: LocationRow,
    locations: list[LocationRow],
    prefer_elevator: bool,
    start_mode: str,    # 'room' | 'entrance_enter'
    end_mode: str,      # 'room' | 'entrance_exit'
) -> RoutePhase:
    """generic indoor a->b. the three public primitives fix start/end modes."""
    if start.building != end.building:
        return RoutePhase(
            kind="indoor", building=start.building,
            polyline=[], steps=[], distance_m=0.0, duration_s=0.0,
            error="cross-building routing is handled by the trip coordinator",
        )
    if start.id == end.id:
        return RoutePhase(
            kind="indoor", building=start.building,
            polyline=[], steps=[], distance_m=0.0, duration_s=0.0,
            error="start and end are the same location",
        )

    sf = parse_floor_min(start, locations)
    ef = parse_floor_min(end, locations)
    if sf is None or ef is None:
        return RoutePhase(
            kind="indoor", building=start.building,
            polyline=[], steps=[], distance_m=0.0, duration_s=0.0,
            error="start or end has no numeric floor",
        )

    steps: list[Step] = []
    if start_mode == "room":
        steps.append(_step_start_at_room(start))
    elif start_mode == "entrance_enter":
        steps.append(_step_enter_building(start))

    # same-floor fast path
    if sf == ef:
        leg = route_leg_on_floor(
            start.point, end.point, start.building, sf, locations
        )

        if start_mode == "room":
            exit_step = _step_exit_room(start, leg)
            if exit_step is not None:
                steps.append(exit_step)

        # drop start point from walk polyline when exit_room already covers it
        walk_poly = leg[1:] if start_mode == "room" else leg

        if end_mode == "entrance_exit":
            steps.append(_step_walk(
                "walk_to_entrance",
                end.room or "the entrance",
                walk_poly,
            ))
            steps.append(_step_exit_building(end))
        else:  # end_mode == 'room'
            steps.append(_step_walk(
                "walk_to_room",
                end.room or "your destination",
                walk_poly,
            ))
            steps.append(_step_arrive_at_room(end, leg))

        total_m = polyline_length_m(leg)
        return RoutePhase(
            kind="indoor",
            building=start.building,
            polyline=leg,
            steps=steps,
            distance_m=total_m,
            duration_s=total_m / WALKING_SPEED_MPS,
            from_floor=sf,
            to_floor=ef,
        )

    # cross-floor: i*op steps 1-5
    flat = route_leg_on_floor(
        start.point, end.point, start.building, sf, locations
    )

    primary = "elevator" if prefer_elevator else "stairs"
    fallback = "stairs" if prefer_elevator else "elevator"

    connector = connector_on_route(flat, start, end, primary, locations)
    subtype = primary
    on_route = connector is not None

    if not connector:
        connector = connector_on_route(flat, start, end, fallback, locations)
        if connector:
            subtype = fallback

    if not connector:
        connector = pick_best_connector(start, end, primary, locations)
        subtype = primary
        if not connector:
            connector = pick_best_connector(start, end, fallback, locations)
            if connector:
                subtype = fallback

    if not connector:
        return RoutePhase(
            kind="indoor", building=start.building,
            polyline=[], steps=[], distance_m=0.0, duration_s=0.0,
            from_floor=sf, to_floor=ef,
            error=f"no {primary} or {fallback} reaches both floors",
        )

    used_fallback = subtype != primary

    leg1 = route_leg_on_floor(
        start.point, connector.point, start.building, sf, locations
    )
    leg2 = route_leg_on_floor(
        connector.point, end.point, end.building, ef, locations
    )

    if start_mode == "room":
        exit_step = _step_exit_room(start, leg1)
        if exit_step is not None:
            steps.append(exit_step)
    walk1_poly = leg1[1:] if start_mode == "room" else leg1
    steps.append(_step_walk(
        "walk_to_connector",
        connector.room or (
            "the stairs" if subtype == "stairs" else "the elevator"
        ),
        walk1_poly,
    ))

    steps.append(_step_change_floor(connector, sf, ef))
    steps.append(_step_exit_connector(connector))

    if end_mode == "entrance_exit":
        steps.append(_step_walk(
            "walk_to_entrance",
            end.room or "the entrance",
            leg2,
        ))
        steps.append(_step_exit_building(end))
    else:  # end_mode == 'room'
        steps.append(_step_walk(
            "walk_to_room",
            end.room or "your destination",
            leg2,
        ))
        steps.append(_step_arrive_at_room(end, leg2))

    # drop duplicated connector point at the seam
    full_polyline = leg1 + leg2[1:]
    total_m = polyline_length_m(leg1) + polyline_length_m(leg2)

    return RoutePhase(
        kind="indoor",
        building=start.building,
        polyline=full_polyline,
        steps=steps,
        distance_m=total_m,
        duration_s=total_m / WALKING_SPEED_MPS,
        connector_used=connector.room,
        connector_kind=subtype,
        from_floor=sf,
        to_floor=ef,
        used_fallback=used_fallback,
        on_route_connector=on_route,
    )


# --- public primitives -------------------------------------------------------


def route_room_to_room(
    start: LocationRow,
    end: LocationRow,
    locations: list[LocationRow],
    *,
    prefer_elevator: bool = False,
) -> RoutePhase:
    """same-building room->room. for v1 this is the only primitive wired into /api/route."""
    return _route_indoor(
        start, end, locations, prefer_elevator,
        start_mode="room", end_mode="room",
    )


def route_room_to_entrance(
    start_room: LocationRow,
    end_entrance: LocationRow,
    locations: list[LocationRow],
    *,
    prefer_elevator: bool = False,
) -> RoutePhase:
    """room -> building exit. first phase of a cross-building trip."""
    return _route_indoor(
        start_room, end_entrance, locations, prefer_elevator,
        start_mode="room", end_mode="entrance_exit",
    )


def route_entrance_to_room(
    start_entrance: LocationRow,
    end_room: LocationRow,
    locations: list[LocationRow],
    *,
    prefer_elevator: bool = False,
) -> RoutePhase:
    """building entrance -> room. last phase of a cross-building trip."""
    return _route_indoor(
        start_entrance, end_room, locations, prefer_elevator,
        start_mode="entrance_enter", end_mode="room",
    )


# --- json serialization ------------------------------------------------------


def phase_to_dict(phase: RoutePhase) -> dict:
    return {
        "kind": phase.kind,
        "building": phase.building,
        "polyline": [list(p) for p in phase.polyline],
        "distance_m": phase.distance_m,
        "duration_s": phase.duration_s,
        "error": phase.error,
        "steps": [step_to_dict(s) for s in phase.steps],
        "connector_used": phase.connector_used,
        "connector_kind": phase.connector_kind,
        "from_floor": phase.from_floor,
        "to_floor": phase.to_floor,
        "used_fallback": phase.used_fallback,
        "on_route_connector": phase.on_route_connector,
    }


def step_to_dict(s: Step) -> dict:
    return {
        "kind": s.kind,
        "text": s.text,
        "polyline": [list(p) for p in s.polyline],
        "distance_m": s.distance_m,
        "connector_name": s.connector_name,
        "connector_kind": s.connector_kind,
        "from_floor": s.from_floor,
        "to_floor": s.to_floor,
        "turn": s.turn,
    }


# --- smoke test --------------------------------------------------------------
# run with: python -m app.indoor_routing


if __name__ == "__main__":
    def row(**kw):
        base = dict(
            subtype=None, orientation=None, room=None, notes=None,
            closest_entrance=None, closest_entrance_elevator=None,
            closest_stair=None, closest_elevator=None,
            direction_from_connector=None, connections=None,
        )
        base.update(kw)
        return LocationRow(**base)

    locs = [
        row(id=1, kind="entrance", orientation="E", building="Hancock",
            floor="1", room="Main Entrance",
            lon=-73.93441, lat=41.72268),
        row(id=2, kind="connector", subtype="stairs", building="Hancock",
            floor="0-3", room="Main Stairs",
            direction_from_connector="turn right, room is on the left",
            lon=-73.93444, lat=41.72264),
        row(id=3, kind="room", building="Hancock", floor="1", room="1021",
            closest_entrance="Main Entrance", closest_stair="Main Stairs",
            lon=-73.93451, lat=41.72290),
        row(id=4, kind="room", building="Hancock", floor="2",
            room="2016 - Conference Room",
            closest_entrance="Main Entrance", closest_stair="Main Stairs",
            lon=-73.93441, lat=41.72267),
        row(id=10, kind="hallway", building="Hancock", floor="*", room="H1",
            connections="H2", lon=-73.93445, lat=41.72285),
        row(id=11, kind="hallway", building="Hancock", floor="*", room="H2",
            connections="H1,H3", lon=-73.93445, lat=41.72268),
        row(id=12, kind="hallway", building="Hancock", floor="*", room="H3",
            connections="H2", lon=-73.93441, lat=41.72268),
    ]

    def show(title, r):
        print(f"=== {title} ===")
        if r.error:
            print(f"  ERROR: {r.error}")
            return
        for s in r.steps:
            print(f"  [{s.kind}] {s.text}")
        print(f"  Total: {r.distance_m:.1f} m, {r.duration_s:.1f} s")
        print()

    show("room 1021 -> room 2016 (cross-floor)",
         route_room_to_room(locs[2], locs[3], locs))

    show("Main Entrance -> room 1021 (enter building, same floor)",
         route_entrance_to_room(locs[0], locs[2], locs))

    show("room 1021 -> Main Entrance (exit building, same floor)",
         route_room_to_entrance(locs[2], locs[0], locs))

    show("room 1021 -> room 2016 (prefer elevator fallback to stairs)",
         route_room_to_room(locs[2], locs[3], locs, prefer_elevator=True))
