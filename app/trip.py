"""
trip coordinator: stitches indoor + outdoor routing into a single response.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app import indoor_routing as ir
from app import routing


# --- endpoint types ----------------------------------------------------------


@dataclass
class Endpoint:
    """One end of a trip. Exactly one of (room, entrance, building, latlon)
    is non-None. kind() reports which."""
    room: ir.LocationRow | None = None
    entrance: ir.LocationRow | None = None
    building: str | None = None
    latlon: tuple[float, float] | None = None
    label: str | None = None

    def kind(self) -> str:
        if self.room is not None:
            return "room"
        if self.entrance is not None:
            return "entrance"
        if self.building is not None:
            return "building"
        if self.latlon is not None:
            return "point"
        raise ValueError("empty Endpoint")

    @property
    def indoor_building(self) -> str | None:
        """Which building (if any) this endpoint belongs to."""
        if self.room is not None:
            return self.room.building
        if self.entrance is not None:
            return self.entrance.building
        if self.building is not None:
            return self.building
        return None

    @property
    def point(self) -> tuple[float, float]:
        """A concrete (lon, lat) for the endpoint, used as a target when
        resolving which entrance is 'nearest' on the other side."""
        if self.room is not None:
            return (self.room.lon, self.room.lat)
        if self.entrance is not None:
            return (self.entrance.lon, self.entrance.lat)
        if self.latlon is not None:
            return self.latlon
        # 'building' with no concrete point — caller should use a list of
        # entrances instead. We return an arbitrary entrance's location so
        # downstream code never NPEs; in practice _pick_building_entrance
        # always runs first.
        raise ValueError("building endpoint has no single point")


class TripError(ValueError):
    """Bubbled up to the http layer as a 422."""


# --- helpers -----------------------------------------------------------------


def _format_distance(meters: float) -> str:
    return ir.format_distance(meters)


def _outdoor_phase_dict(
    route: routing.Route,
    *,
    from_label: str | None,
    to_label: str | None,
) -> dict:
    polyline = [list(p) for p in route.trackpoints]
    start_label = from_label or "your start"
    end_label = to_label or "your destination"
    steps = [
        {
            "kind": "walk_outdoor",
            "text": (
                f"Walk from {start_label} to {end_label} "
                f"({_format_distance(route.distance_m)})."
            ),
            "polyline": polyline,
            "distance_m": route.distance_m,
            "connector_name": None,
            "connector_kind": None,
            "from_floor": None,
            "to_floor": None,
            "turn": None,
        },
    ]
    return {
        "kind": "outdoor",
        "building": None,
        "polyline": polyline,
        "distance_m": route.distance_m,
        "duration_s": route.duration_s,
        "error": None,
        "steps": steps,
        "connector_used": None,
        "connector_kind": None,
        "from_floor": None,
        "to_floor": None,
        "used_fallback": False,
        "on_route_connector": False,
    }


def _phase_ok(phase_dict: dict) -> bool:
    return phase_dict.get("error") is None and bool(phase_dict.get("polyline"))


def _total_distance(phases: list[dict]) -> float:
    return sum(p.get("distance_m") or 0.0 for p in phases)


def _total_duration(phases: list[dict]) -> float:
    return sum(p.get("duration_s") or 0.0 for p in phases)


def _concat_polylines(phases: list[dict]) -> list[list[float]]:
    out: list[list[float]] = []
    for i, phase in enumerate(phases):
        pts = phase.get("polyline") or []
        if i > 0 and out and pts and list(out[-1]) == list(pts[0]):
            pts = pts[1:]
        out.extend(list(p) for p in pts)
    return out


# --- phase builders ----------------------------------------------------------


def _indoor_room_to_room(a, b, locations, *, prefer_elevator):
    return ir.phase_to_dict(
        ir.route_room_to_room(a, b, locations, prefer_elevator=prefer_elevator)
    )


def _indoor_room_to_entrance(room, entrance, locations, *, prefer_elevator):
    return ir.phase_to_dict(
        ir.route_room_to_entrance(
            room, entrance, locations, prefer_elevator=prefer_elevator
        )
    )


def _indoor_entrance_to_room(entrance, room, locations, *, prefer_elevator):
    return ir.phase_to_dict(
        ir.route_entrance_to_room(
            entrance, room, locations, prefer_elevator=prefer_elevator
        )
    )


def _outdoor_between(src, dst, *, from_label, to_label):
    try:
        route = routing.shortest_path(
            src, dst, origin_label=from_label, destination_label=to_label,
        )
    except routing.RoutingError as err:
        return {
            "kind": "outdoor", "building": None, "polyline": [],
            "distance_m": 0.0, "duration_s": 0.0,
            "error": str(err), "steps": [],
            "connector_used": None, "connector_kind": None,
            "from_floor": None, "to_floor": None,
            "used_fallback": False, "on_route_connector": False,
        }
    return _outdoor_phase_dict(route, from_label=from_label, to_label=to_label)


# --- entrance resolution -----------------------------------------------------


def _entrances_of(building: str, locations: list[ir.LocationRow]) -> list[ir.LocationRow]:
    return [
        e for e in locations
        if e.kind == "entrance" and e.building == building
    ]


def _haversine_m(a, b):
    # cheap — used only for entrance picking on small buildings
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(h))


def _nearest_entrance(
    building: str,
    target_point: tuple[float, float],
    locations: list[ir.LocationRow],
) -> ir.LocationRow | None:
    entrances = _entrances_of(building, locations)
    if not entrances:
        return None
    return min(entrances, key=lambda e: _haversine_m((e.lon, e.lat), target_point))


# --- phase plans, parameterized by "how do we leave / enter each building" ---


def _leave_building_phase(
    start: Endpoint,
    via: ir.LocationRow,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> dict | None:
    """Produce the indoor phase getting from `start` out to entrance `via`.
    Returns None when no indoor phase is needed (the start IS the entrance,
    or the start wasn't indoor to begin with)."""
    k = start.kind()
    if k == "room":
        return _indoor_room_to_entrance(
            start.room, via, locations, prefer_elevator=prefer_elevator,
        )
    if k == "entrance":
        # Start is itself an entrance — no indoor phase, caller should use
        # `via = start.entrance` anyway.
        return None
    if k == "building":
        # Buildings have no interior starting point. Nothing to walk indoors.
        return None
    return None  # 'point' — caller shouldn't call this


def _enter_building_phase(
    end: Endpoint,
    via: ir.LocationRow,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> dict | None:
    k = end.kind()
    if k == "room":
        return _indoor_entrance_to_room(
            via, end.room, locations, prefer_elevator=prefer_elevator,
        )
    return None  # entrance/building/point — no indoor last-leg needed


def _start_exit_point(start: Endpoint, via: ir.LocationRow | None) -> tuple[float, float]:
    """Where the outdoor phase begins after leaving `start`."""
    if via is not None:
        return (via.lon, via.lat)
    # No entrance (start is an outdoor point)
    return start.point


def _end_entry_point(end: Endpoint, via: ir.LocationRow | None) -> tuple[float, float]:
    if via is not None:
        return (via.lon, via.lat)
    return end.point


def _plan_cross_building(
    start: Endpoint,
    end: Endpoint,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> list[dict]:
    """Generic plan for trips where the two sides may be indoor or outdoor.

    We enumerate candidate "exit from start" and "entry to end" entrances:
    - If start is a room / building, every entrance of start.building is a
      candidate. If start is an entrance, only that entrance. If start is
      a plain point, there's no entrance to leave through.
    - Symmetric for end.

    Then we build every viable (exit, entry) combination, score by total
    distance, and keep the best.
    """
    start_bldg = start.indoor_building
    end_bldg = end.indoor_building

    # Candidate "exit" entrances (None means "no indoor leaving phase")
    if start.kind() == "entrance":
        exits: list[ir.LocationRow | None] = [start.entrance]
    elif start.kind() in ("room", "building") and start_bldg:
        exits = list(_entrances_of(start_bldg, locations))
        if not exits:
            raise TripError(f"{start_bldg} has no entrances mapped")
    else:  # 'point'
        exits = [None]

    if end.kind() == "entrance":
        entries: list[ir.LocationRow | None] = [end.entrance]
    elif end.kind() in ("room", "building") and end_bldg:
        entries = list(_entrances_of(end_bldg, locations))
        if not entries:
            raise TripError(f"{end_bldg} has no entrances mapped")
    else:
        entries = [None]

    # Same-building special case: both sides are in the same building and
    # at least one side is a room. Route purely indoors, no entrance hop.
    if (
        start_bldg
        and start_bldg == end_bldg
        and start.kind() == "room"
        and end.kind() == "room"
    ):
        p = _indoor_room_to_room(
            start.room, end.room, locations,
            prefer_elevator=prefer_elevator,
        )
        if not _phase_ok(p):
            raise TripError(p.get("error") or "indoor routing failed")
        return [p]

    best: list[dict] | None = None
    best_total = math.inf

    for ex in exits:
        leaving = _leave_building_phase(
            start, ex, locations, prefer_elevator=prefer_elevator,
        ) if ex is not None else None
        if leaving is not None and not _phase_ok(leaving):
            continue

        exit_pt = _start_exit_point(start, ex)
        exit_label = (
            f"{ex.building} ({ex.room})" if ex and ex.room
            else (start.label if start.kind() == "point" else (ex.building if ex else None))
        )

        for en in entries:
            entering = _enter_building_phase(
                end, en, locations, prefer_elevator=prefer_elevator,
            ) if en is not None else None
            if entering is not None and not _phase_ok(entering):
                continue

            entry_pt = _end_entry_point(end, en)
            entry_label = (
                f"{en.building} ({en.room})" if en and en.room
                else (end.label if end.kind() == "point" else (en.building if en else None))
            )

            # When the exit entrance and entry entrance are the same
            # physical point (same building, same entrance, or start IS
            # the entrance the route enters through), the outdoor phase
            # would be zero-length and add a meaningless step. Drop it.
            skip_outdoor = (
                abs(exit_pt[0] - entry_pt[0]) < 1e-9
                and abs(exit_pt[1] - entry_pt[1]) < 1e-9
            )
            if skip_outdoor:
                outdoor = None
            else:
                outdoor = _outdoor_between(
                    exit_pt, entry_pt,
                    from_label=exit_label, to_label=entry_label,
                )
                if not _phase_ok(outdoor):
                    continue

            plan = [p for p in (leaving, outdoor, entering) if p is not None]
            total = _total_distance(plan)
            if total < best_total:
                best_total = total
                best = plan

    if best is None:
        raise TripError("no viable route found")
    return best


# --- main entry point --------------------------------------------------------


def plan_trip(
    start: Endpoint,
    end: Endpoint,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool = False,
) -> dict:
    # Reject trivially empty trips up front
    if (
        start.kind() == "room" and end.kind() == "room"
        and start.room.id == end.room.id
    ):
        raise TripError("start and end are the same room")
    if (
        start.kind() == "entrance" and end.kind() == "entrance"
        and start.entrance.id == end.entrance.id
    ):
        raise TripError("start and end are the same entrance")

    phases = _plan_cross_building(
        start, end, locations, prefer_elevator=prefer_elevator,
    )

    trackpoints = _concat_polylines(phases)
    distance_m = _total_distance(phases)
    duration_s = _total_duration(phases)
    origin_label = start.label or _auto_label(start)
    destination_label = end.label or _auto_label(end)

    return {
        "distance_m": distance_m,
        "duration_s": duration_s,
        "geometry": {"type": "LineString", "coordinates": trackpoints},
        "feature": {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": trackpoints},
            "properties": {"distance_m": distance_m, "duration_s": duration_s},
        },
        "trackpoints": trackpoints,
        "phases": phases,
        "origin_label": origin_label,
        "destination_label": destination_label,
    }


def _auto_label(ep: Endpoint) -> str | None:
    k = ep.kind()
    if k == "room":
        return f"{ep.room.building} {ep.room.room}"
    if k == "entrance":
        return f"{ep.entrance.building} {ep.entrance.room or 'entrance'}"
    if k == "building":
        return ep.building
    return None
