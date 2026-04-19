"""
cached loader for the `locations` table.

indoor_routing.py operates on list[LocationRow] dataclasses rather than db
"""


from __future__ import annotations

import threading

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.extensions import db
from app.indoor_routing import LocationRow


_LOCK = threading.Lock()
_LOCATIONS: list[LocationRow] | None = None


_SQL = text(
    """
    SELECT id,
           kind,
           subtype,
           orientation,
           building,
           floor,
           room,
           notes,
           closest_entrance,
           closest_entrance_elevator,
           closest_stair,
           closest_elevator,
           direction_from_connector,
           connections,
           ST_X(loc) AS lon,
           ST_Y(loc) AS lat
    FROM locations
    """
)


def _row_to_location(row) -> LocationRow:
    return LocationRow(
        id=row["id"],
        kind=row["kind"],
        subtype=row["subtype"],
        orientation=row["orientation"],
        building=row["building"],
        floor=row["floor"],
        room=row["room"],
        notes=row["notes"],
        closest_entrance=row["closest_entrance"],
        closest_entrance_elevator=row["closest_entrance_elevator"],
        closest_stair=row["closest_stair"],
        closest_elevator=row["closest_elevator"],
        direction_from_connector=row["direction_from_connector"],
        connections=row["connections"],
        lon=float(row["lon"]),
        lat=float(row["lat"]),
    )


def load_locations() -> list[LocationRow]:
    """return the full location set, building the cache on first use."""
    global _LOCATIONS
    if _LOCATIONS is not None:
        return _LOCATIONS
    with _LOCK:
        if _LOCATIONS is None:
            try:
                rows = db.session.execute(_SQL).mappings().all()
                _LOCATIONS = [_row_to_location(r) for r in rows]
            except SQLAlchemyError:
                db.session.rollback()
                _LOCATIONS = []
    return _LOCATIONS


def reset_locations_cache() -> None:
    global _LOCATIONS
    with _LOCK:
        _LOCATIONS = None


# --- lookups -----------------------------------------------------------------


def find_room(building: str, room: str) -> LocationRow | None:
    """exact match on (building, kind='room', room). case-insensitive
    building, case-sensitive room (room labels sometimes contain
    meaningful capitalization like '2016 - Conference Room')."""
    target_b = (building or "").strip().lower()
    target_r = (room or "").strip()
    for e in load_locations():
        if e.kind != "room":
            continue
        if (e.building or "").lower() != target_b:
            continue
        if (e.room or "") == target_r:
            return e
    return None


def find_entrance(building: str, name: str) -> LocationRow | None:
    target_b = (building or "").strip().lower()
    target_n = (name or "").strip()
    for e in load_locations():
        if e.kind != "entrance":
            continue
        if (e.building or "").lower() != target_b:
            continue
        if (e.room or "") == target_n:
            return e
    return None


def entrances_for(building: str) -> list[LocationRow]:
    target = (building or "").strip().lower()
    return [
        e for e in load_locations()
        if e.kind == "entrance" and (e.building or "").lower() == target
    ]


def list_buildings() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for e in load_locations():
        b = (e.building or "").strip()
        if not b or b in seen:
            continue
        seen.add(b)
        out.append(b)
    out.sort(key=str.lower)
    return out


# --- search targets (powers the client-side autocomplete) --------------------


def _pad_room_tokens(room: str) -> list[str]:
    """Split a room name like '2016 - Conference Room' into searchable
    chunks. We keep the full string, any all-digit runs, and any lowercase
    word so queries like 'conference' still hit.
    """
    if not room:
        return []
    toks: list[str] = [room.strip()]
    cur = ""
    for ch in room:
        if ch.isalnum():
            cur += ch
        else:
            if cur:
                toks.append(cur)
                cur = ""
    if cur:
        toks.append(cur)
    return toks


def list_targets() -> list[dict]:
    """Flat list of everything the client-side autocomplete can match.

    The `tokens` array contains every lowercase string the matcher should
    try prefix/substring matches against. `label` is the primary display
    text; `sublabel` fills the secondary line. `endpoint` is an opaque-ish
    bag the client posts back verbatim as query params on /api/route.
    """
    targets: list[dict] = []
    locs = load_locations()

    # Buildings that actually have mapped content.
    buildings_seen: dict[str, LocationRow] = {}
    for e in locs:
        if not e.building or e.kind == "hallway":
            continue
        if e.building not in buildings_seen:
            buildings_seen[e.building] = e

    for name in sorted(buildings_seen, key=str.lower):
        entrances = entrances_for(name)
        sub = f"Building · {len(entrances)} entrance{'s' if len(entrances) != 1 else ''}"
        targets.append({
            "kind": "building",
            "label": name,
            "sublabel": sub,
            "building": name,
            "tokens": [name.lower()] + name.lower().split(),
            "endpoint": {"kind": "building", "building": name},
        })

    for e in locs:
        if e.kind != "room" or not e.room:
            continue
        tokens = [e.building.lower()] + e.building.lower().split()
        for t in _pad_room_tokens(e.room):
            tokens.append(t.lower())
        targets.append({
            "kind": "room",
            "label": f"{e.room}",
            "sublabel": f"{e.building} · Floor {e.floor}",
            "building": e.building,
            "room": e.room,
            "floor": e.floor,
            "tokens": tokens,
            "endpoint": {"kind": "room", "building": e.building, "room": e.room},
        })

    for e in locs:
        if e.kind != "entrance" or not e.room:
            continue
        tokens = [e.building.lower()] + e.building.lower().split()
        for t in _pad_room_tokens(e.room):
            tokens.append(t.lower())
        tokens.append("entrance")
        targets.append({
            "kind": "entrance",
            "label": f"{e.room}",
            "sublabel": f"{e.building} · Entrance",
            "building": e.building,
            "room": e.room,
            "tokens": tokens,
            "endpoint": {"kind": "entrance", "building": e.building, "name": e.room},
        })

    return targets
