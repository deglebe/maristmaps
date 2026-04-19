import json
import os
import re

from flask import Blueprint, Response, abort, jsonify, render_template, request, session
from langchain_core.messages import SystemMessage, message_to_dict, messages_from_dict
from openai import BadRequestError

from agent.logutil import get_logger, trunc_preview
from agent.service import looks_like_question, run_agent_turn_b64, speech_to_text
from app import routing, trip
from app.locations import (
    find_entrance,
    find_room,
    list_buildings,
    list_targets,
    load_locations,
    reset_locations_cache,
)
from app.osm_features import (
    building_name_overrides,
    feature_to_search_dict,
    load_osm_buildings,
    load_osm_paths,
    load_osm_pois,
    reset_osm_cache,
)

bp = Blueprint("main", __name__)
agent_http_log = get_logger("http")

# LangChain agent conversation (signed cookie session; kept small).
_AGENT_SESSION_KEY = "agent_lc_messages_v1"
_AGENT_MAX_MESSAGES = 24
_AGENT_MAX_COOKIE_BYTES = 3800


def _prune_agent_message_dicts(ser: list) -> list:
    """Keep recent history and stay under rough cookie size limits."""
    out = list(ser)
    while len(out) > _AGENT_MAX_MESSAGES:
        out.pop(0)
    while len(json.dumps(out).encode("utf-8")) > _AGENT_MAX_COOKIE_BYTES and len(out) > 4:
        out = out[4:]
    return out


def _load_agent_session_messages():
    raw = session.get(_AGENT_SESSION_KEY)
    if not raw:
        return []
    try:
        msgs = messages_from_dict(raw)
    except (TypeError, ValueError, KeyError):
        session.pop(_AGENT_SESSION_KEY, None)
        return []
    return [m for m in msgs if not isinstance(m, SystemMessage)]


def _save_agent_session_messages(msgs: list) -> None:
    stripped = [m for m in msgs if not isinstance(m, SystemMessage)]
    ser = [message_to_dict(m) for m in stripped]
    ser = _prune_agent_message_dicts(ser)
    session[_AGENT_SESSION_KEY] = ser
    session.modified = True


def _map_page_config():
    base = os.environ.get("MARTIN_PUBLIC_URL", "http://127.0.0.1:3000").rstrip("/")
    return {
        "martinBase": base,
        "center": [
            float(os.environ.get("MAP_CENTER_LON", "-73.93446921913481")),
            float(os.environ.get("MAP_CENTER_LAT", "41.72233476143977")),
        ],
        "zoom": float(os.environ.get("MAP_ZOOM", "16.5")),
        "buildingNameOverrides": building_name_overrides(),
    }


@bp.route("/")
def index():
    return render_template("index.html", map_config=_map_page_config())


@bp.route("/map")
def map_only():
    return render_template("map.html", map_config=_map_page_config())


# ---------------------------------------------------------------------------
# Features
# ---------------------------------------------------------------------------


@bp.route("/api/features")
def api_features():
    features: list[dict] = []
    for f in load_osm_buildings():
        features.append(feature_to_search_dict(f))
    for f in load_osm_pois():
        features.append(feature_to_search_dict(f))
    for f in load_osm_paths():
        features.append(feature_to_search_dict(f))
    features.sort(key=lambda f: (f["kind"], (f["name"] or "").lower()))
    return jsonify({"features": features, "count": len(features)})


@bp.route("/api/indoor/index")
def api_indoor_index():
    """Flat list of indoor search targets: rooms, entrances, and
    buildings. The client does fuzzy matching in-browser; we just ship
    the data.

    Each target looks like:
        {
          "kind": "room" | "entrance" | "building",
          "label": "1021",
          "sublabel": "Hancock · Floor 1",
          "building": "Hancock",
          "room": "1021",                 # present on room/entrance
          "floor": "1",                   # present on room
          "tokens": ["hancock", "1021"],  # all lowercased search strings
          "endpoint": { ... }             # opaque payload for /api/route
        }
    """
    return jsonify({
        "targets": list_targets(),
        "buildings": list_buildings(),
    })


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def _parse_lonlat_optional(prefix: str) -> tuple[float, float] | None:
    raw_lon = request.args.get(f"{prefix}_lon")
    raw_lat = request.args.get(f"{prefix}_lat")
    if raw_lon is None and raw_lat is None:
        return None
    if raw_lon is None or raw_lat is None:
        abort(400, description=f"need both {prefix}_lon and {prefix}_lat")
    try:
        lon = float(raw_lon)
        lat = float(raw_lat)
    except (TypeError, ValueError):
        abort(400, description=f"invalid {prefix}_lon / {prefix}_lat")
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        abort(400, description=f"{prefix} coordinates out of range")
    return lon, lat


def _resolve_endpoint(prefix: str) -> trip.Endpoint:
    """Turn query-string params into a trip.Endpoint.

    Precedence (highest first):
      <prefix>_kind=room      + <prefix>_building + <prefix>_room
      <prefix>_kind=entrance  + <prefix>_building + <prefix>_name
      <prefix>_kind=building  + <prefix>_building
      <prefix>_building + <prefix>_room   (back-compat: implies kind=room)
      <prefix>_lon + <prefix>_lat        (outdoor point)

    Returning a typed Endpoint up-front keeps trip.py agnostic of the
    wire format.
    """
    kind = (request.args.get(f"{prefix}_kind") or "").strip().lower()
    building = (request.args.get(f"{prefix}_building") or "").strip()
    room = (request.args.get(f"{prefix}_room") or "").strip()
    name = (request.args.get(f"{prefix}_name") or "").strip()
    label = request.args.get(f"{prefix}_label") or None

    # Infer kind when client sent only building+room (back-compat with
    # the previous frontend).
    if not kind and building and room:
        kind = "room"
    if not kind and building and not room and not name:
        # Bare building param with no room — treat as building endpoint.
        # (Previously this would 400.)
        kind = "building"

    if kind == "room":
        if not building or not room:
            abort(400, description=f"{prefix}: room endpoint needs building + room")
        loc = find_room(building, room)
        if loc is None:
            abort(404, description=f"no room {room!r} in {building!r}")
        return trip.Endpoint(room=loc, label=label or f"{loc.building} {loc.room}")

    if kind == "entrance":
        if not building or not name:
            abort(400, description=f"{prefix}: entrance endpoint needs building + name")
        loc = find_entrance(building, name)
        if loc is None:
            abort(404, description=f"no entrance {name!r} in {building!r}")
        return trip.Endpoint(
            entrance=loc,
            label=label or f"{loc.building} {loc.room or 'entrance'}",
        )

    if kind == "building":
        if not building:
            abort(400, description=f"{prefix}: building endpoint needs building")
        return trip.Endpoint(building=building, label=label or building)

    # Fall through to outdoor lat/lon.
    latlon = _parse_lonlat_optional(prefix)
    if latlon is None:
        abort(400, description=f"missing {prefix} endpoint")
    return trip.Endpoint(latlon=latlon, label=label)


def _prefer_elevator_flag() -> bool:
    v = (request.args.get("prefer_elevator") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _compute_trip_from_request() -> dict:
    start = _resolve_endpoint("from")
    end = _resolve_endpoint("to")
    locations = load_locations()
    try:
        return trip.plan_trip(
            start, end, locations,
            prefer_elevator=_prefer_elevator_flag(),
        )
    except trip.TripError as err:
        abort(422, description=str(err))


@bp.route("/api/route")
def api_route():
    """Unified indoor + outdoor routing. See _resolve_endpoint for params."""
    return jsonify(_compute_trip_from_request())


_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename_part(label: str | None, fallback: str) -> str:
    cleaned = _FILENAME_SAFE.sub("_", (label or "").strip()).strip("._-")
    return cleaned or fallback


@bp.route("/api/route.gpx")
def api_route_gpx():
    plan = _compute_trip_from_request()
    origin_label = plan.get("origin_label")
    destination_label = plan.get("destination_label")
    filename_bits = [
        _safe_filename_part(origin_label, "start"),
        "to",
        _safe_filename_part(destination_label, "end"),
    ]
    filename = "_".join(filename_bits)[:120] + ".gpx"
    trackpoints = [tuple(p) for p in plan["trackpoints"]]
    if len(trackpoints) < 2:
        abort(422, description="empty route")
    synthetic = routing.Route(
        trackpoints=trackpoints,
        distance_m=plan["distance_m"],
        duration_s=plan["duration_s"],
        origin=trackpoints[0],
        destination=trackpoints[-1],
        origin_label=origin_label,
        destination_label=destination_label,
    )
    xml = routing.route_to_gpx(
        synthetic,
        name=f"{origin_label or 'Start'} → {destination_label or 'End'}",
    )
    return Response(
        xml,
        mimetype="application/gpx+xml",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@bp.route("/api/route/debug")
def api_route_debug():
    stats = routing.debug_stats()
    locs = load_locations()
    stats["locations_total"] = len(locs)
    stats["locations_by_kind"] = {}
    for e in locs:
        stats["locations_by_kind"][e.kind] = stats["locations_by_kind"].get(e.kind, 0) + 1
    return jsonify(stats)


@bp.route("/api/route/rebuild", methods=["POST"])
def api_route_rebuild():
    routing.reset_graph_cache()
    reset_locations_cache()
    reset_osm_cache()
    return jsonify({"ok": True})


@bp.route("/api/agent/transcribe", methods=["POST"])
def api_agent_transcribe():
    """Speech-to-text (Whisper). Expects multipart field ``audio``."""
    if not os.environ.get("OPENAI_API_KEY"):
        abort(503, description="OPENAI_API_KEY is not configured")
    f = request.files.get("audio")
    if f is None or f.filename == "":
        abort(400, description="missing audio file")
    raw = f.read()
    if not raw:
        abort(400, description="empty audio upload")
    agent_http_log.info(
        "POST /api/agent/transcribe bytes=%s filename=%s",
        len(raw),
        f.filename,
    )
    text = speech_to_text(raw, f.filename or "audio.webm", f.mimetype)
    agent_http_log.info("POST /api/agent/transcribe done text_len=%s", len(text))
    return jsonify({"text": text})


@bp.route("/api/agent", methods=["POST"])
def api_agent():
    """Run the navigation agent: JSON body with ``message`` and optional start hints.

    Session: conversation is stored in the Flask session so follow-ups keep context.
    Send ``reset: true`` to start a new conversation.

    Response ``response_code`` / ``response_code_numeric``:
      ``CLARIFICATION_PENDING`` / 1 — assistant asked a question; ``reopen_mic`` is true.
      ``ROUTE_READY`` / 2 — a route was computed; ``reopen_mic`` is false.
      ``NO_ACTION`` / 0 — assistant replied without a route or a question;
      ``reopen_mic`` is false so the voice loop terminates.
    """
    if not os.environ.get("OPENAI_API_KEY"):
        abort(503, description="OPENAI_API_KEY is not configured")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, description="expected JSON object")

    if data.get("reset"):
        session.pop(_AGENT_SESSION_KEY, None)
        session.modified = True

    message = (data.get("message") or "").strip()
    if not message:
        abort(400, description="message is required")

    from_label = data.get("from_label")
    from_lon = data.get("from_lon")
    from_lat = data.get("from_lat")

    history = _load_agent_session_messages()
    agent_http_log.info(
        "POST /api/agent reset=%s message_preview=%r history_messages=%s from_lon=%s from_lat=%s from_label=%r",
        bool(data.get("reset")),
        trunc_preview(message, 900),
        len(history),
        from_lon,
        from_lat,
        from_label,
    )

    try:
        reply, plan, audio_b64, outbound = run_agent_turn_b64(
            message,
            history=history,
            from_lon=from_lon,
            from_lat=from_lat,
            from_label=from_label if isinstance(from_label, str) else None,
        )
    except BadRequestError as err:
        agent_http_log.warning(
            "POST /api/agent OpenAI BadRequestError (session cleared): %s",
            err,
        )
        session.pop(_AGENT_SESSION_KEY, None)
        session.modified = True
        abort(
            502,
            description="Chat session was reset (invalid history). Retry your message.",
        )
    except RuntimeError as err:
        agent_http_log.exception("POST /api/agent RuntimeError: %s", err)
        abort(503, description=str(err))

    try:
        _save_agent_session_messages(outbound)
    except Exception:
        session.pop(_AGENT_SESSION_KEY, None)
        session.modified = True

    # A turn only "needs clarification" when the assistant actually asked a
    # question. If the model produced a plan we're done; if it produced
    # filler ("sure, planning that for you") with no plan and no question we
    # do NOT reopen the mic — that would loop the user into nonsense voice
    # rounds.
    if plan is not None:
        needs_clarification = False
        response_code = "ROUTE_READY"
    elif looks_like_question(reply):
        needs_clarification = True
        response_code = "CLARIFICATION_PENDING"
    else:
        needs_clarification = False
        response_code = "NO_ACTION"
    response_code_numeric = 0 if response_code == "NO_ACTION" else (
        2 if response_code == "ROUTE_READY" else 1
    )

    agent_http_log.info(
        "POST /api/agent response response_code=%s navigated=%s reopen_mic=%s reply_preview=%r audio_b64_len=%s",
        response_code,
        plan is not None,
        needs_clarification,
        trunc_preview(reply, 600),
        len(audio_b64) if audio_b64 else 0,
    )

    return jsonify({
        "reply": reply,
        "navigated": plan is not None,
        "route": plan,
        "audio_base64": audio_b64,
        "audio_mime": "audio/mpeg" if audio_b64 else None,
        "response_code": response_code,
        "response_code_numeric": response_code_numeric,
        "reopen_mic": needs_clarification,
    })
