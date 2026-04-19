import json
import os
from pathlib import Path
import re

from flask import Blueprint, Response, abort, jsonify, render_template, request, session
from langchain_core.messages import SystemMessage, message_to_dict, messages_from_dict
from openai import BadRequestError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from agent.logutil import get_logger, trunc_preview
from agent.service import run_agent_turn_b64, speech_to_text
from app import routing, trip
from app.extensions import db
from app.locations import (
    find_entrance,
    find_room,
    list_buildings,
    list_targets,
    load_locations,
    reset_locations_cache,
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


_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_BUILDING_OVERRIDES_PATH = _DATA_DIR / "building_name_overrides.json"


def _load_building_name_overrides():
    """OSM way id → display name for buildings missing or weak names in OSM."""
    if not _BUILDING_OVERRIDES_PATH.is_file():
        return {}
    try:
        raw = json.loads(_BUILDING_OVERRIDES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        ks = str(k).strip()
        if ks.startswith("__"):
            continue
        if v is None or str(v).strip() == "":
            continue
        out[ks] = str(v).strip()
    return out


def _map_page_config():
    base = os.environ.get("MARTIN_PUBLIC_URL", "http://127.0.0.1:3000").rstrip("/")
    return {
        "martinBase": base,
        "center": [
            float(os.environ.get("MAP_CENTER_LON", "-73.93446921913481")),
            float(os.environ.get("MAP_CENTER_LAT", "41.72233476143977")),
        ],
        "zoom": float(os.environ.get("MAP_ZOOM", "16.5")),
        "buildingNameOverrides": _load_building_name_overrides(),
    }


@bp.route("/")
def index():
    return render_template("index.html", map_config=_map_page_config())


@bp.route("/map")
def map_only():
    return render_template("map.html", map_config=_map_page_config())


# ---------------------------------------------------------------------------
# Features (unchanged)
# ---------------------------------------------------------------------------

_BUILDINGS_SQL = text(
    """
    SELECT osm_id, name, building, amenity,
           ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
           ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
    FROM planet_osm_polygon
    WHERE building IS NOT NULL AND name IS NOT NULL AND trim(name) <> ''
    """
)

_POIS_SQL = text(
    """
    SELECT osm_id, name, amenity, shop, tourism, leisure, office,
           ST_X(ST_Transform(way, 4326)) AS lon,
           ST_Y(ST_Transform(way, 4326)) AS lat
    FROM planet_osm_point
    WHERE name IS NOT NULL AND trim(name) <> ''
      AND (amenity IS NOT NULL OR shop IS NOT NULL OR tourism IS NOT NULL
           OR leisure IS NOT NULL OR office IS NOT NULL)
    """
)

_PATHS_SQL = text(
    """
    SELECT osm_id, name, highway,
           ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
           ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
    FROM planet_osm_line
    WHERE name IS NOT NULL AND trim(name) <> ''
      AND highway = ANY(:path_kinds)
    """
)
_PATH_KINDS_PARAM = list(routing.PATH_KINDS + routing.STAIR_KINDS)

_BUILDING_POLYGON_BY_OSM_SQL = text(
    """
    SELECT osm_id,
           name,
           building,
           amenity,
           ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
           ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
    FROM planet_osm_polygon
    WHERE osm_id = :osm_id AND building IS NOT NULL
    LIMIT 1
    """
)


def _safe_rows(sql, params=None):
    try:
        return list(db.session.execute(sql, params or {}).mappings())
    except SQLAlchemyError:
        db.session.rollback()
        return []


def _safe_one(sql, params):
    try:
        row = db.session.execute(sql, params).mappings().first()
        return dict(row) if row else None
    except SQLAlchemyError:
        db.session.rollback()
        return None


def _apply_building_name_overrides(features):
    """Apply data/building_name_overrides.json; add search rows for unnamed polygons."""
    overrides = _load_building_name_overrides()
    if not overrides:
        return
    by_osm = {f["osm_id"]: f for f in features if f.get("kind") == "building"}
    for oid_str, label in overrides.items():
        try:
            oid = int(oid_str)
        except (TypeError, ValueError):
            continue
        if oid in by_osm:
            by_osm[oid]["name"] = label
            continue
        row = _safe_one(_BUILDING_POLYGON_BY_OSM_SQL, {"osm_id": oid})
        if not row:
            continue
        lon, lat = row["lon"], row["lat"]
        if lon is None or lat is None:
            continue
        features.append(
            {
                "id": f"way/{oid}",
                "osm_id": oid,
                "kind": "building",
                "name": label,
                "subtitle": _building_subtitle(row),
                "lon": float(lon),
                "lat": float(lat),
            }
        )


def _building_subtitle(row):
    parts = []
    if row["amenity"]:
        parts.append(str(row["amenity"]).replace("_", " "))
    btype = row["building"]
    if btype and btype != "yes":
        parts.append(str(btype).replace("_", " "))
    return " · ".join(parts) or "Building"


def _poi_subtitle(row):
    for key in ("amenity", "shop", "tourism", "leisure", "office"):
        val = row[key]
        if val:
            return str(val).replace("_", " ")
    return "Point of interest"


def _path_subtitle(row):
    highway = row["highway"] or "path"
    return str(highway).replace("_", " ")


@bp.route("/api/features")
def api_features():
    features = []
    for row in _safe_rows(_BUILDINGS_SQL):
        lon, lat = row["lon"], row["lat"]
        if lon is None or lat is None:
            continue
        features.append({
            "id": f"way/{row['osm_id']}", "osm_id": row["osm_id"],
            "kind": "building", "name": row["name"],
            "subtitle": _building_subtitle(row),
            "lon": float(lon), "lat": float(lat),
        })
    for row in _safe_rows(_POIS_SQL):
        lon, lat = row["lon"], row["lat"]
        if lon is None or lat is None:
            continue
        features.append({
            "id": f"node/{row['osm_id']}", "osm_id": row["osm_id"],
            "kind": "poi", "name": row["name"],
            "subtitle": _poi_subtitle(row),
            "lon": float(lon), "lat": float(lat),
        })
    seen_path_names = set()
    for row in _safe_rows(_PATHS_SQL, {"path_kinds": _PATH_KINDS_PARAM}):
        name = row["name"]
        if name in seen_path_names:
            continue
        lon, lat = row["lon"], row["lat"]
        if lon is None or lat is None:
            continue
        seen_path_names.add(name)
        features.append(
            {
                "id": f"way/{row['osm_id']}",
                "osm_id": row["osm_id"],
                "kind": "path",
                "name": name,
                "subtitle": _path_subtitle(row),
                "lon": float(lon),
                "lat": float(lat),
            }
        )

    _apply_building_name_overrides(features)
    
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
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# OpenAI / LangChain agent (HTTP API + optional voice client in search.js)
# ---------------------------------------------------------------------------


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
      ``CLARIFICATION_PENDING`` / 1 — needs more info; ``reopen_mic`` is true.
      ``ROUTE_READY`` / 2 — a route was computed; ``reopen_mic`` is false.
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

    needs_clarification = plan is None
    response_code = "CLARIFICATION_PENDING" if needs_clarification else "ROUTE_READY"
    response_code_numeric = 1 if needs_clarification else 2

    agent_http_log.info(
        "POST /api/agent response response_code=%s navigated=%s reply_preview=%r audio_b64_len=%s",
        response_code,
        plan is not None,
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
