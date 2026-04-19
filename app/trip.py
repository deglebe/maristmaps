"""
trip coordinator: stitches indoor + outdoor routing into a single response.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from app import building_bridges
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
    walk_text = (
        f"Walk from {start_label} to {end_label} "
        f"({_format_distance(route.distance_m)})."
    )
    steps = [
        {
            "kind": "walk_outdoor",
            "text": ir.expand_compass_for_speech(walk_text),
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


def _bridge_phase_dict(
    from_entrance: ir.LocationRow,
    to_entrance: ir.LocationRow,
) -> dict:
    """Synthetic zero-length phase: pass through a bridge between buildings.

    Rendered as a single step so the step list shows the transition
    explicitly instead of jumping mysteriously from one building's
    interior to another. Polyline is the shared door point in both
    from/to orientations so the map line reads continuously.
    """
    pt_a = [from_entrance.lon, from_entrance.lat]
    pt_b = [to_entrance.lon, to_entrance.lat]
    polyline = [pt_a, pt_b]
    text = f"Pass through into {to_entrance.building}."
    steps = [
        {
            "kind": "bridge",
            "text": ir.expand_compass_for_speech(text),
            "polyline": polyline,
            "distance_m": 0.0,
            "connector_name": None,
            "connector_kind": None,
            "from_floor": None,
            "to_floor": None,
            "turn": None,
        },
    ]
    return {
        # Tagged 'indoor' so the frontend renders it with indoor styling.
        # It has no meaningful "building" since it's between two buildings;
        # frontend just shows the step text.
        "kind": "indoor",
        "building": to_entrance.building,
        "polyline": polyline,
        "distance_m": 0.0,
        "duration_s": 0.0,
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


def _indoor_entrance_to_entrance(a, b, locations, *, prefer_elevator):
    return ir.phase_to_dict(
        ir.route_entrance_to_entrance(
            a, b, locations, prefer_elevator=prefer_elevator
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


# A bare (lat, lon) that lands within this many meters of a known room or
# entrance is treated as that anchor for routing purposes. Handles trips
# where the frontend sent coordinates for e.g. "Hancock 2020" without a
# room reference — so the same-building fast path below can still see that
# both endpoints live inside Hancock and skip the outdoor loop.
_POINT_TO_ANCHOR_THRESHOLD_M = 30.0


def _resolve_point_to_anchor(
    ep: "Endpoint",
    locations: list[ir.LocationRow],
) -> ir.LocationRow | None:
    """Nearest indoor anchor (room preferred over entrance) within
    ``_POINT_TO_ANCHOR_THRESHOLD_M`` meters of ``ep``, or None.

    Only called for point endpoints; returns None for any other kind.
    """
    if ep.kind() != "point":
        return None
    target = ep.latlon
    best: ir.LocationRow | None = None
    # (tier, distance); lower tier wins. Rooms are tier 0, entrances tier 1.
    best_score: tuple[int, float] = (2, math.inf)
    for row in locations:
        if row.kind == "room":
            tier = 0
        elif row.kind == "entrance":
            tier = 1
        else:
            continue
        d = _haversine_m((row.lon, row.lat), target)
        if d > _POINT_TO_ANCHOR_THRESHOLD_M:
            continue
        score = (tier, d)
        if score < best_score:
            best_score = score
            best = row
    return best


def _promote_point_endpoint(
    ep: "Endpoint",
    locations: list[ir.LocationRow],
) -> "Endpoint":
    """If ``ep`` is a point landing on a known room/entrance, return an
    Endpoint of that anchor kind. Otherwise return ``ep`` unchanged.

    Genuinely outdoor points (quads, parking lots, off-campus) don't match
    any anchor and pass through untouched.
    """
    anchor = _resolve_point_to_anchor(ep, locations)
    if anchor is None:
        return ep
    label = ep.label  # preserve whatever the caller set
    if anchor.kind == "room":
        return Endpoint(room=anchor, label=label)
    return Endpoint(entrance=anchor, label=label)


def _same_building_indoor_plan(
    start: "Endpoint",
    end: "Endpoint",
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> dict | None:
    """Route purely indoors when both endpoints anchor in the same building.

    Covers every room/entrance combination. Invariant: if you're in
    Hancock going to somewhere else in Hancock, you never step outside.
    Returns None when no indoor pairing applies (e.g. one side is still a
    plain 'building' endpoint with no concrete anchor) so the caller can
    fall back to the general planner.
    """
    sk, ek = start.kind(), end.kind()
    if sk == "room" and ek == "room":
        p = _indoor_room_to_room(
            start.room, end.room, locations, prefer_elevator=prefer_elevator,
        )
    elif sk == "room" and ek == "entrance":
        p = _indoor_room_to_entrance(
            start.room, end.entrance, locations,
            prefer_elevator=prefer_elevator,
        )
    elif sk == "entrance" and ek == "room":
        p = _indoor_entrance_to_room(
            start.entrance, end.room, locations,
            prefer_elevator=prefer_elevator,
        )
    elif sk == "entrance" and ek == "entrance":
        p = _indoor_entrance_to_entrance(
            start.entrance, end.entrance, locations,
            prefer_elevator=prefer_elevator,
        )
    else:
        return None
    return p if _phase_ok(p) else None


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


def _exit_label(start: Endpoint, ex: ir.LocationRow | None) -> str | None:
    if ex and ex.room:
        return f"{ex.building} ({ex.room})"
    if ex:
        return ex.building
    if start.kind() == "point":
        return start.label
    return None


def _entry_label(end: Endpoint, en: ir.LocationRow | None) -> str | None:
    if en and en.room:
        return f"{en.building} ({en.room})"
    if en:
        return en.building
    if end.kind() == "point":
        return end.label
    return None


def _direct_plans(
    start: Endpoint,
    end: Endpoint,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> list[list[dict]]:
    """All (leave, outdoor, enter) candidate plans — no bridges."""
    start_bldg = start.indoor_building
    end_bldg = end.indoor_building

    if start.kind() == "entrance":
        exits: list[ir.LocationRow | None] = [start.entrance]
    elif start.kind() in ("room", "building") and start_bldg:
        exits = list(_entrances_of(start_bldg, locations))
        if not exits:
            raise TripError(f"{start_bldg} has no entrances mapped")
    else:
        exits = [None]

    if end.kind() == "entrance":
        entries: list[ir.LocationRow | None] = [end.entrance]
    elif end.kind() in ("room", "building") and end_bldg:
        entries = list(_entrances_of(end_bldg, locations))
        if not entries:
            raise TripError(f"{end_bldg} has no entrances mapped")
    else:
        entries = [None]

    plans: list[list[dict]] = []
    for ex in exits:
        leaving = _leave_building_phase(
            start, ex, locations, prefer_elevator=prefer_elevator,
        ) if ex is not None else None
        if leaving is not None and not _phase_ok(leaving):
            continue

        exit_pt = _start_exit_point(start, ex)
        exit_label = _exit_label(start, ex)

        for en in entries:
            entering = _enter_building_phase(
                end, en, locations, prefer_elevator=prefer_elevator,
            ) if en is not None else None
            if entering is not None and not _phase_ok(entering):
                continue

            entry_pt = _end_entry_point(end, en)
            entry_label = _entry_label(end, en)

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

            plans.append([p for p in (leaving, outdoor, entering) if p is not None])
    return plans


def _end_anchored_bridged_plans(
    start: Endpoint,
    end: Endpoint,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> list[list[dict]]:
    """Candidate plans that pass through one intermediate building via a
    bridge into ``end.building``.

    Shape (5 phases when start != intermediate):
      leave_start -> outdoor -> traverse_intermediate -> bridge -> enter_end
    Shape (3-4 phases when start == intermediate):
      [traverse_start_to_bridge] -> bridge -> enter_end

    We enumerate over every bridge whose far side lands in end.building.
    This also covers the case where start.building is directly bridged
    to end.building (intermediate == start.building).
    """
    end_bldg = end.indoor_building
    if not end_bldg:
        return []
    if end.kind() not in ("room", "entrance"):
        return []

    bridges_in = building_bridges.entrances_bridging_to(end_bldg)
    if not bridges_in:
        return []

    start_bldg = start.indoor_building

    if start.kind() == "entrance":
        exits: list[ir.LocationRow | None] = [start.entrance]
    elif start.kind() in ("room", "building") and start_bldg:
        exits = list(_entrances_of(start_bldg, locations)) or []
    else:
        exits = [None]

    plans: list[list[dict]] = []
    for (near_ent, far_ent) in bridges_in:
        intermediate_bldg = near_ent.building

        if end.kind() == "room":
            entering = _enter_building_phase(
                end, far_ent, locations, prefer_elevator=prefer_elevator,
            )
            if entering is None or not _phase_ok(entering):
                continue
        elif end.kind() == "entrance":
            if not (end.entrance and end.entrance.id == far_ent.id):
                continue
            entering = None
        else:
            continue

        bridge_phase = _bridge_phase_dict(near_ent, far_ent)

        if start_bldg and start_bldg == intermediate_bldg:
            if start.kind() == "room":
                traverse = _indoor_room_to_entrance(
                    start.room, near_ent, locations,
                    prefer_elevator=prefer_elevator,
                )
            elif start.kind() == "entrance":
                if start.entrance and start.entrance.id == near_ent.id:
                    traverse = None
                else:
                    traverse = _indoor_entrance_to_entrance(
                        start.entrance, near_ent, locations,
                        prefer_elevator=prefer_elevator,
                    )
            else:
                continue
            if traverse is not None and not _phase_ok(traverse):
                continue
            plan = [p for p in (traverse, bridge_phase, entering) if p is not None]
            plans.append(plan)
            continue

        inter_entrances = _entrances_of(intermediate_bldg, locations)
        if not inter_entrances:
            continue

        for ex in exits:
            leaving = _leave_building_phase(
                start, ex, locations, prefer_elevator=prefer_elevator,
            ) if ex is not None else None
            if leaving is not None and not _phase_ok(leaving):
                continue
            exit_pt = _start_exit_point(start, ex)
            exit_label = _exit_label(start, ex)

            for inter_in in inter_entrances:
                skip_outdoor = (
                    abs(exit_pt[0] - inter_in.lon) < 1e-9
                    and abs(exit_pt[1] - inter_in.lat) < 1e-9
                )
                if skip_outdoor:
                    outdoor = None
                else:
                    outdoor = _outdoor_between(
                        exit_pt, (inter_in.lon, inter_in.lat),
                        from_label=exit_label,
                        to_label=f"{inter_in.building} ({inter_in.room})"
                        if inter_in.room else inter_in.building,
                    )
                    if not _phase_ok(outdoor):
                        continue

                if inter_in.id == near_ent.id:
                    traverse = None
                else:
                    traverse = _indoor_entrance_to_entrance(
                        inter_in, near_ent, locations,
                        prefer_elevator=prefer_elevator,
                    )
                    if not _phase_ok(traverse):
                        continue

                plan = [
                    p for p in (leaving, outdoor, traverse, bridge_phase, entering)
                    if p is not None
                ]
                plans.append(plan)
    return plans


def _start_anchored_bridged_plans(
    start: Endpoint,
    end: Endpoint,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> list[list[dict]]:
    """Candidate plans that exit ``start.building`` via a bridge into an
    intermediate neighbor, then route to ``end.building`` from there.
    """
    end_bldg = end.indoor_building
    start_bldg = start.indoor_building
    if not start_bldg:
        return []
    if start.kind() not in ("room", "entrance"):
        return []

    bridges_out = building_bridges.entrances_bridging_from(start_bldg)
    if not bridges_out:
        return []

    plans: list[list[dict]] = []
    for (my_ent, their_ent) in bridges_out:
        intermediate_bldg = their_ent.building

        # Skip when the intermediate IS the end building — the
        # end-anchored enumeration already generates this plan shape
        # (start->intermediate is a bridge into end_bldg directly).
        if end_bldg and intermediate_bldg == end_bldg:
            continue

        # Leave start and cross the bridge.
        if start.kind() == "room":
            leaving = _indoor_room_to_entrance(
                start.room, my_ent, locations,
                prefer_elevator=prefer_elevator,
            )
            if not _phase_ok(leaving):
                continue
        elif start.kind() == "entrance":
            if start.entrance and start.entrance.id == my_ent.id:
                leaving = None
            else:
                leaving = _indoor_entrance_to_entrance(
                    start.entrance, my_ent, locations,
                    prefer_elevator=prefer_elevator,
                )
                if not _phase_ok(leaving):
                    continue
        else:
            continue

        bridge_phase = _bridge_phase_dict(my_ent, their_ent)

        # From the intermediate-side entrance, we now need to reach
        # end.building. Enumerate every intermediate exit (entrance) we
        # could walk out of, plus every end-building entrance we could
        # enter (when end is indoor).
        inter_entrances = _entrances_of(intermediate_bldg, locations)
        # their_ent itself counts as a valid exit from the intermediate
        # (no indoor traverse needed), which _entrances_of already
        # includes.

        # End-side entries follow the same rules as _direct_plans.
        if end.kind() == "entrance":
            entries: list[ir.LocationRow | None] = [end.entrance]
        elif end.kind() in ("room", "building") and end_bldg:
            entries = list(_entrances_of(end_bldg, locations))
            if not entries:
                continue
        else:
            entries = [None]

        for inter_exit in inter_entrances:
            # Traverse inside the intermediate from their_ent to inter_exit.
            if inter_exit.id == their_ent.id:
                traverse = None
            else:
                traverse = _indoor_entrance_to_entrance(
                    their_ent, inter_exit, locations,
                    prefer_elevator=prefer_elevator,
                )
                if not _phase_ok(traverse):
                    continue

            exit_pt = (inter_exit.lon, inter_exit.lat)
            exit_label = (
                f"{inter_exit.building} ({inter_exit.room})"
                if inter_exit.room else inter_exit.building
            )

            for en in entries:
                entering = _enter_building_phase(
                    end, en, locations, prefer_elevator=prefer_elevator,
                ) if en is not None else None
                if entering is not None and not _phase_ok(entering):
                    continue

                entry_pt = _end_entry_point(end, en)
                entry_label = _entry_label(end, en)

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

                plan = [
                    p for p in (leaving, bridge_phase, traverse, outdoor, entering)
                    if p is not None
                ]
                plans.append(plan)
    return plans


def _bridged_plans(
    start: Endpoint,
    end: Endpoint,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> list[list[dict]]:
    plans: list[list[dict]] = []
    plans.extend(_end_anchored_bridged_plans(
        start, end, locations, prefer_elevator=prefer_elevator,
    ))
    plans.extend(_start_anchored_bridged_plans(
        start, end, locations, prefer_elevator=prefer_elevator,
    ))
    return plans


def _plan_cross_building(
    start: Endpoint,
    end: Endpoint,
    locations: list[ir.LocationRow],
    *,
    prefer_elevator: bool,
) -> list[dict]:
    """Generic plan for trips where the two sides may be indoor or outdoor.

    """
    # First, upgrade bare coordinate endpoints that happen to land on a
    # known room or entrance. Without this, a destination sent as
    # (lat, lon) for "Hancock 2020" arrives as a 'point' with no
    # building association, and the same-building check below can't
    # fire — we'd end up planning "exit Hancock, walk outside, re-enter
    # Hancock" for a trip that should stay entirely indoors.
    start = _promote_point_endpoint(start, locations)
    end = _promote_point_endpoint(end, locations)

    start_bldg = start.indoor_building
    end_bldg = end.indoor_building

    # Same-building invariant: if both endpoints anchor in the same
    # building, the trip never goes outside. Broader than the old
    # "both endpoints are rooms" check — covers room/entrance pairings
    # and the promoted-from-point case above.
    if start_bldg and start_bldg == end_bldg:
        p = _same_building_indoor_plan(
            start, end, locations, prefer_elevator=prefer_elevator,
        )
        if p is not None:
            return [p]
        # If same-building indoor routing returned None (e.g. one side is
        # still a 'building' endpoint with no concrete anchor), fall
        # through to the general planner rather than hard-erroring.

    candidates: list[list[dict]] = []
    candidates.extend(_direct_plans(
        start, end, locations, prefer_elevator=prefer_elevator,
    ))
    candidates.extend(_bridged_plans(
        start, end, locations, prefer_elevator=prefer_elevator,
    ))

    if not candidates:
        raise TripError("no viable route found")

    return min(candidates, key=_total_distance)


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


def _strip_parens_label(s: str | None) -> str:
    """Drop parenthetical qualifiers from labels, e.g. ``Dyson (NE)`` → ``Dyson``."""
    if not s:
        return ""
    return re.sub(r"\s*\([^)]*\)", "", str(s).strip()).strip()


def _non_arrival_step_count(plan: dict) -> int:
    n = 0
    for ph in plan.get("phases") or []:
        if ph.get("error"):
            continue
        for st in ph.get("steps") or []:
            if (st.get("kind") or "") != "arrive":
                n += 1
    return n


def _compact_outdoor_line(od: dict, next_ph: dict | None, dest_label: str) -> str:
    target = None
    if next_ph and next_ph.get("kind") == "indoor" and next_ph.get("building"):
        target = str(next_ph["building"]).strip()
    if not target:
        target = _strip_parens_label(dest_label) or "the destination"
    if target.lower() in ("your location", "your start"):
        target = _strip_parens_label(dest_label) or "the building"
    return f"Walk to {target}."


def _extract_walk_dest(walk_text: str) -> str | None:
    m = re.search(r"Walk to\s+(.+?)\s*\(", walk_text or "", re.DOTALL)
    if not m:
        return None
    return m.group(1).strip()


def _strip_distances_from_sentence(text: str) -> str:
    """Remove parenthetical distance hints (feet, meters) from step prose."""
    if not text:
        return text
    out = re.sub(
        r"\s*\([^)]*(?:feet|foot|ft\.?|\bm\b|meter|metre)[^)]*\)",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", out).strip()


def _compact_indoor_lines(phase: dict, dest_label: str, *, max_clauses: int) -> str:
    """Short clauses for TTS; no distances; skips arrival and start-at-room."""
    parts: list[str] = []
    dest_short = _strip_parens_label(dest_label)
    for s in phase.get("steps") or []:
        if len(parts) >= max_clauses:
            break
        k = s.get("kind") or ""
        if k in ("arrive", "start_at_room"):
            continue
        text = (s.get("text") or "").strip()
        if k == "enter_building":
            m = re.search(r"on the\s+(.+?)\s+side", text, re.IGNORECASE | re.DOTALL)
            if m:
                parts.append(f"Enter on the {m.group(1).strip()}.")
            else:
                parts.append("Go inside.")
        elif k in ("walk_to_room", "walk_to_entrance", "walk_to_connector"):
            wdest = _extract_walk_dest(text) or dest_short or "your destination"
            lead = "Then go to " if parts else "Go to "
            parts.append(f"{lead}{wdest}.")
        elif k == "change_floor":
            if text:
                t = _strip_distances_from_sentence(text)
                parts.append(t if t.endswith(".") else t + ".")
        elif k == "exit_connector":
            if text:
                first = text.split(".")[0].strip()
                first = _strip_distances_from_sentence(first)
                parts.append(first + "." if first else text)
        elif k in ("exit_room", "exit_building"):
            if text:
                t = _strip_distances_from_sentence(text)
                parts.append(t if t.endswith(".") else t + ".")
        elif k == "bridge":
            # Surface the bridge transition in the voice summary so the
            # listener knows they're crossing into another building.
            if text:
                parts.append(text if text.endswith(".") else text + ".")
    return " ".join(parts)


def brief_step_summary_for_reply(plan: dict, *, max_steps: int = 10) -> str | None:
    """Short readable \"how to get there\" for agent voice/UI.

    Omits single-leg routes. Compact, distance-free sentences (no meters or feet).
    """
    if _non_arrival_step_count(plan) <= 1:
        return None
    dest = (plan.get("destination_label") or "").strip() or "your destination"
    phases = [p for p in (plan.get("phases") or []) if not p.get("error")]
    chunks: list[str] = []
    i = 0
    while i < len(phases):
        ph = phases[i]
        kind = ph.get("kind")
        if kind == "outdoor":
            nxt = phases[i + 1] if i + 1 < len(phases) else None
            chunks.append(_compact_outdoor_line(ph, nxt, dest))
            i += 1
        elif kind == "indoor":
            line = _compact_indoor_lines(ph, dest, max_clauses=max_steps)
            if line:
                chunks.append(line)
            i += 1
        else:
            i += 1
    if not chunks:
        return None
    merged = " ".join(chunks)
    return ir.expand_compass_for_speech(merged)


def _auto_label(ep: Endpoint) -> str | None:
    k = ep.kind()
    if k == "room":
        return f"{ep.room.building} {ep.room.room}"
    if k == "entrance":
        return f"{ep.entrance.building} {ep.entrance.room or 'entrance'}"
    if k == "building":
        return ep.building
    return None
