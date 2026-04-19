from __future__ import annotations

from typing import Optional

from langchain_core.tools import tool

from agent.logutil import get_logger, trunc_preview
from app import trip
from app.locations import (
    find_room,
    load_locations,
    normalize_room_code,
    resolve_building_for_agent,
)
from agent.nav_context import stash_navigation_plan

log = get_logger("tools")


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
    dest_b = resolve_building_for_agent((destination_building or "").strip())
    if not dest_b:
        log.warning("tool_navigate fail: missing destination building")
        return "NAVIGATION_FAILED: Destination building is missing."

    locations = load_locations()
    dest_room = normalize_room_code(destination_room) or None
    log.info(
        "tool_navigate resolved dest_building=%r dest_room=%r locations_loaded=%s",
        dest_b,
        dest_room,
        len(locations),
    )

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
        cur_b = resolve_building_for_agent((current_building or "").strip())
        cur_room = normalize_room_code(current_room) or None
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
    dist = plan.get("distance_m")
    dist_s = f"{int(round(dist))} m" if isinstance(dist, (int, float)) else ""
    out = (
        f"ROUTE_OK: Planned route from {origin} to {dest}"
        + (f" ({dist_s})" if dist_s else "")
        + ". Summarize the trip briefly for the user."
    )
    log.info("tool_navigate success return_preview=%r", trunc_preview(out, 500))
    return out
