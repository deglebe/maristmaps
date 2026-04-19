from __future__ import annotations

from typing import Optional

from langchain_core.tools import tool

from agent.logutil import get_logger, trunc_preview
from app import trip
from app.locations import (
    find_room,
    list_buildings,
    load_locations,
    normalize_room_code,
    resolve_building_for_agent,
)
from app.osm_features import (
    find_osm_destination,
    list_osm_destinations,
)
from agent.nav_context import stash_navigation_plan
import difflib

log = get_logger("tools")


@tool
def find_place(query: str, limit: int = 5) -> str:
    """Look up whether a free-text place name matches a known map location.

    Use this BEFORE `navigate` when you are not sure a name will resolve,
    when the request is ambiguous (e.g. just "the gym"), or when you want
    to disambiguate between several similar names. Returns up to `limit`
    matches with their kind so you can pick the right one and pass its
    exact name to `navigate`.

    The matcher checks indoor buildings (rooms available) first, then
    falls back to OSM-known places (other campus buildings, off-campus
    shops/restaurants/POIs).

    Returns:
      "PLACES_FOUND: <kind:name (subtitle)>; <kind:name (subtitle)>; ..."
      or "PLACES_NONE: <reason>" when nothing matches.
    """
    raw = (query or "").strip()
    if not raw:
        return "PLACES_NONE: Empty query."
    cap = max(1, min(int(limit or 5), 10))

    rlow = raw.lower()
    if rlow.startswith("the "):
        rlow = rlow[4:]
    tokens = [t for t in rlow.split() if t]
    indoor = list_buildings()

    def score(name: str) -> float:
        nl = name.lower()
        if nl == rlow:
            return 1.0
        if nl.startswith(rlow) or rlow.startswith(nl):
            return 0.95
        if rlow in nl or nl in rlow:
            return 0.9
        if tokens and all(t in nl for t in tokens):
            return 0.85
        return difflib.SequenceMatcher(None, rlow, nl).ratio()

    out: list[str] = []
    seen_lower: set[str] = set()

    indoor_scored = [(score(b), b) for b in indoor]
    indoor_scored = [(s, b) for s, b in indoor_scored if s >= 0.6]
    indoor_scored.sort(key=lambda r: (-r[0], len(r[1]), r[1].lower()))
    for _, b in indoor_scored[:cap]:
        out.append(f"indoor_building:{b} (rooms available)")
        seen_lower.add(b.lower())

    if len(out) < cap:
        osm_scored: list[tuple[float, object]] = []
        for f in list_osm_destinations():
            n = (f.name or "").strip()
            if not n or n.lower() in seen_lower:
                continue
            s = score(n)
            if s >= 0.6:
                osm_scored.append((s, f))
        osm_scored.sort(key=lambda r: (-r[0], len(r[1].name), r[1].name.lower()))
        for _, f in osm_scored[: cap - len(out)]:
            sub = f.subtitle or f.kind
            out.append(f"{f.kind}:{f.name} ({sub})")

    if not out:
        msg = f"PLACES_NONE: No place matched {raw!r}."
        log.info("tool_find_place miss query=%r", raw)
        return msg

    res = "PLACES_FOUND: " + "; ".join(out)
    log.info("tool_find_place hits query=%r preview=%r", raw, trunc_preview(res, 400))
    return res


@tool
def navigate(
    destination_building: str,
    destination_room: Optional[str] = None,
    current_building: Optional[str] = None,
    current_room: Optional[str] = None,
    current_lon: Optional[float] = None,
    current_lat: Optional[float] = None,
    prefer_elevator: bool = False,
) -> str:
    """Compute a walking route on campus.

    Call this only when you know where the user wants to go (destination building,
    and room if relevant) AND you know where they are starting from.

    Starting point: either (current_lon + current_lat) for an outdoor GPS/map point,
    or (current_building) with optional current_room for an indoor start.

    Destination: destination_building is required; include destination_room when
    the user named a specific room or office.

    On success, returns a short confirmation. On failure, returns an error
    message the user can understand — do not claim the route was computed.
    """
    log.info(
        "tool_navigate invoke raw: destination_building=%r destination_room=%r "
        "current_building=%r current_room=%r current_lon=%s current_lat=%s prefer_elevator=%s",
        destination_building,
        destination_room,
        current_building,
        current_room,
        current_lon,
        current_lat,
        prefer_elevator,
    )
    raw_dest = (destination_building or "").strip()
    if not raw_dest:
        log.warning("tool_navigate fail: missing destination building")
        return "NAVIGATION_FAILED: Destination building is missing."

    locations = load_locations()
    indoor_buildings = {b.lower() for b in list_buildings()}
    dest_room = normalize_room_code(destination_room) or None

    dest_b = resolve_building_for_agent(raw_dest)
    dest_is_indoor = dest_b.lower() in indoor_buildings

    log.info(
        "tool_navigate resolved dest_building=%r dest_room=%r dest_is_indoor=%s locations_loaded=%s",
        dest_b,
        dest_room,
        dest_is_indoor,
        len(locations),
    )

    if dest_is_indoor:
        if dest_room:
            room_row = find_room(dest_b, dest_room)
            if room_row is None:
                msg = (
                    f"NAVIGATION_FAILED: No room {dest_room!r} found in building {dest_b!r}. "
                    "Ask the user for the exact building and room as shown on the door or directory."
                )
                log.warning("tool_navigate fail: find_room miss %s", trunc_preview(msg, 400))
                return msg
            end = trip.Endpoint(room=room_row, label=f"{room_row.building} {room_row.room}")
        else:
            end = trip.Endpoint(building=dest_b, label=dest_b)
    else:
        # Off-campus or campus-but-not-indoor-mapped: fall back to OSM lookup.
        feat = find_osm_destination(raw_dest)
        if feat is None:
            msg = (
                f"NAVIGATION_FAILED: Could not find a place named {raw_dest!r} on the map. "
                "Ask the user to rephrase the destination or pick from the search bar."
            )
            log.warning("tool_navigate fail: osm miss %s", trunc_preview(msg, 400))
            return msg
        if dest_room:
            log.info(
                "tool_navigate ignoring dest_room=%r for off-map destination %r",
                dest_room,
                feat.name,
            )
        end = trip.Endpoint(latlon=(feat.lon, feat.lat), label=feat.name)

    if current_lon is not None and current_lat is not None:
        try:
            lon = float(current_lon)
            lat = float(current_lat)
        except (TypeError, ValueError):
            log.warning("tool_navigate fail: invalid lon/lat")
            return "NAVIGATION_FAILED: Current coordinates are invalid."
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            log.warning("tool_navigate fail: lon/lat out of range")
            return "NAVIGATION_FAILED: Current coordinates are out of range."
        start = trip.Endpoint(
            latlon=(lon, lat),
            label="Your location",
        )
    elif (current_building or "").strip():
        raw_cur = (current_building or "").strip()
        cur_b = resolve_building_for_agent(raw_cur)
        cur_room = normalize_room_code(current_room) or None
        cur_is_indoor = cur_b.lower() in indoor_buildings
        if cur_is_indoor:
            if cur_room:
                start_row = find_room(cur_b, cur_room)
                if start_row is None:
                    log.warning(
                        "tool_navigate fail: start room miss building=%r room=%r",
                        cur_b,
                        cur_room,
                    )
                    return (
                        f"NAVIGATION_FAILED: Could not find starting room {cur_room!r} in {cur_b!r}."
                    )
                start = trip.Endpoint(room=start_row, label=f"{start_row.building} {start_row.room}")
            else:
                start = trip.Endpoint(building=cur_b, label=cur_b)
        else:
            feat = find_osm_destination(raw_cur)
            if feat is None:
                log.warning("tool_navigate fail: osm start miss raw=%r", raw_cur)
                return (
                    f"NAVIGATION_FAILED: Could not find a place named {raw_cur!r} to start from. "
                    "Ask the user for a known building or share their map location."
                )
            start = trip.Endpoint(latlon=(feat.lon, feat.lat), label=feat.name)
    else:
        log.warning("tool_navigate fail: no start point")
        return (
            "NAVIGATION_FAILED: Need a starting point: either current building "
            "(and optional room) or map coordinates (lon/lat)."
        )

    log.info(
        "tool_navigate endpoints start_kind=%s end_kind=%s",
        start.kind(),
        end.kind(),
    )
    try:
        plan = trip.plan_trip(
            start,
            end,
            locations,
            prefer_elevator=bool(prefer_elevator),
        )
    except trip.TripError as err:
        log.warning("tool_navigate trip.TripError: %s", err)
        return f"NAVIGATION_FAILED: {err}"

    stash_navigation_plan(plan)
    origin = plan.get("origin_label") or "Start"
    dest = plan.get("destination_label") or "Destination"
    out = (
        f"ROUTE_OK: Planned route from {origin} to {dest}. "
        "Reply with ONE short friendly sentence only. Do not give distances "
        "(meters, feet, miles), do not list steps or turn-by-turn directions, "
        "and do not repeat wording from step-by-step instructions — the app "
        "shows the route separately."
    )
    log.info("tool_navigate success return_preview=%r", trunc_preview(out, 500))
    return out
