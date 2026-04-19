"""Auto-detect "bridged" entrances between physically joined buildings.

Two indoor buildings count as bridged when a user can walk between them
without going outside. Rather than enumerate those pairings in config,
we infer them from data surveyors already enter:

A pair of ``entrance`` rows (a, b) is a bridge iff ALL hold:
  1. a.building != b.building
  2. haversine(a, b) <= BRIDGE_MAX_DISTANCE_M  (floor is ignored)
  3. a's entrance name mentions b's building name (case-insensitive
     substring), AND b's entrance name mentions a's building name

"""

from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass

from app.indoor_routing import LocationRow
from app.locations import load_locations

_log = logging.getLogger(__name__)


# Tight enough that unrelated entrances in adjacent buildings can't
# match by coincidence; loose enough to survive GPS survey jitter.
# The one real pair in our data (Rotunda Midrise Entrance <->
# Midrise Rotunda Entrance) is about 0.6 m apart, so 5 m gives
# generous headroom without inviting false positives.
BRIDGE_MAX_DISTANCE_M = 5.0


@dataclass(frozen=True)
class Bridge:
    """One detected bridge between two entrance rows in different buildings."""
    a: LocationRow
    b: LocationRow

    def other(self, entrance: LocationRow) -> LocationRow | None:
        if entrance.id == self.a.id:
            return self.b
        if entrance.id == self.b.id:
            return self.a
        return None


_LOCK = threading.Lock()
# Flat list of Bridge objects (deduped, unordered within a pair).
_BRIDGES: list[Bridge] | None = None
# id(entrance) -> list[Bridge]. An entrance can in principle belong to
# more than one bridge if three buildings meet at a point, though in
# practice we've never seen that.
_BY_ENTRANCE: dict[int, list[Bridge]] | None = None


def _haversine_m(a: LocationRow, b: LocationRow) -> float:
    lon1, lat1 = math.radians(a.lon), math.radians(a.lat)
    lon2, lat2 = math.radians(b.lon), math.radians(b.lat)
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * 6_371_008.8 * math.asin(math.sqrt(h))


def _names_cross_reference(a: LocationRow, b: LocationRow) -> bool:
    """True iff each entrance's name contains the other's building name.

    """
    a_name = (a.room or "").strip().lower()
    b_name = (b.room or "").strip().lower()
    a_bldg = (a.building or "").strip().lower()
    b_bldg = (b.building or "").strip().lower()
    if not (a_name and b_name and a_bldg and b_bldg):
        return False
    return (b_bldg in a_name) and (a_bldg in b_name)


def _detect_bridges(locations: list[LocationRow]) -> list[Bridge]:
    entrances = [e for e in locations if e.kind == "entrance"]
    out: list[Bridge] = []
    seen: set[tuple[int, int]] = set()
    # O(n^2) over entrances — tiny set (tens at most), runs once per
    # process unless reset_bridges_cache is called.
    for i in range(len(entrances)):
        a = entrances[i]
        for j in range(i + 1, len(entrances)):
            b = entrances[j]
            if (a.building or "") == (b.building or ""):
                continue
            if _haversine_m(a, b) > BRIDGE_MAX_DISTANCE_M:
                continue
            if not _names_cross_reference(a, b):
                continue
            key = (min(a.id, b.id), max(a.id, b.id))
            if key in seen:
                continue
            seen.add(key)
            out.append(Bridge(a=a, b=b))
    if out:
        _log.info(
            "building_bridges detected %d bridge(s): %s",
            len(out),
            ", ".join(
                f"{br.a.building}/{br.a.room} <-> {br.b.building}/{br.b.room}"
                for br in out
            ),
        )
    else:
        _log.debug("building_bridges detected none")
    return out


def _build_indexes() -> None:
    global _BRIDGES, _BY_ENTRANCE
    with _LOCK:
        if _BRIDGES is not None and _BY_ENTRANCE is not None:
            return
        bridges = _detect_bridges(load_locations())
        by_ent: dict[int, list[Bridge]] = {}
        for br in bridges:
            by_ent.setdefault(br.a.id, []).append(br)
            by_ent.setdefault(br.b.id, []).append(br)
        _BRIDGES = bridges
        _BY_ENTRANCE = by_ent


def all_bridges() -> list[Bridge]:
    _build_indexes()
    return list(_BRIDGES or [])


def bridges_for_entrance(entrance: LocationRow) -> list[Bridge]:
    """Every bridge this entrance participates in (usually 0 or 1)."""
    _build_indexes()
    return list((_BY_ENTRANCE or {}).get(entrance.id, []))


def bridged_entrance(entrance: LocationRow) -> LocationRow | None:
    """Return the paired entrance on the other side of a bridge, or None.

    """
    brs = bridges_for_entrance(entrance)
    if len(brs) != 1:
        return None
    return brs[0].other(entrance)


def entrances_bridging_to(building: str) -> list[tuple[LocationRow, LocationRow]]:
    """List ``(near, far)`` entrance pairs where ``far.building == building``.

    Useful when planning "through X to Y" routes: given Y, find every
    entrance in some neighbor that lands you in Y via a bridge.
    """
    target = (building or "").strip().lower()
    out: list[tuple[LocationRow, LocationRow]] = []
    for br in all_bridges():
        if (br.a.building or "").lower() == target:
            out.append((br.b, br.a))
        elif (br.b.building or "").lower() == target:
            out.append((br.a, br.b))
    return out


def entrances_bridging_from(building: str) -> list[tuple[LocationRow, LocationRow]]:
    """List ``(my, their)`` entrance pairs where ``my.building == building``.

    """
    src = (building or "").strip().lower()
    out: list[tuple[LocationRow, LocationRow]] = []
    for br in all_bridges():
        if (br.a.building or "").lower() == src:
            out.append((br.a, br.b))
        elif (br.b.building or "").lower() == src:
            out.append((br.b, br.a))
    return out


def reset_bridges_cache() -> None:
    global _BRIDGES, _BY_ENTRANCE
    with _LOCK:
        _BRIDGES = None
        _BY_ENTRANCE = None
