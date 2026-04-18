import os
import re

from flask import Blueprint, Response, abort, jsonify, render_template, request
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import routing
from app.extensions import db

bp = Blueprint("main", __name__)


def _map_page_config():
    base = os.environ.get("MARTIN_PUBLIC_URL", "http://127.0.0.1:3000").rstrip("/")
    return {
        "martinBase": base,
        "center": [
            float(os.environ.get("MAP_CENTER_LON", "-73.93446921913481")),
            float(os.environ.get("MAP_CENTER_LAT", "41.72233476143977")),
        ],
        "zoom": float(os.environ.get("MAP_ZOOM", "16.5")),
    }


@bp.route("/")
def index():
    return render_template("index.html", map_config=_map_page_config())


@bp.route("/map")
def map_only():
    """Bare map view without the search overlay, for debugging / embedding."""
    return render_template("map.html", map_config=_map_page_config())


# The `planet_osm_*` tables come from osm2pgsql's default.style (see
# scripts/load-osm.sh). `way` is a geometry in EPSG:3857; we reproject the
# centroid to 4326 for the client. Everything is wrapped in per-query
# try/except so a missing table (e.g. before the first OSM import) just
# contributes zero features instead of 500ing the whole endpoint.
_BUILDINGS_SQL = text(
    """
    SELECT osm_id,
           name,
           building,
           amenity,
           ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
           ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
    FROM planet_osm_polygon
    WHERE building IS NOT NULL
      AND name IS NOT NULL
      AND trim(name) <> ''
    """
)

_POIS_SQL = text(
    """
    SELECT osm_id,
           name,
           amenity,
           shop,
           tourism,
           leisure,
           office,
           ST_X(ST_Transform(way, 4326)) AS lon,
           ST_Y(ST_Transform(way, 4326)) AS lat
    FROM planet_osm_point
    WHERE name IS NOT NULL
      AND trim(name) <> ''
      AND (amenity IS NOT NULL
           OR shop IS NOT NULL
           OR tourism IS NOT NULL
           OR leisure IS NOT NULL
           OR office IS NOT NULL)
    """
)

# Paths = pedestrian/bike/foot ways (not vehicle roads). The routing
# module owns the canonical list; we reuse it so the two never drift.
_PATHS_SQL = text(
    """
    SELECT osm_id,
           name,
           highway,
           ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
           ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
    FROM planet_osm_line
    WHERE name IS NOT NULL
      AND trim(name) <> ''
      AND highway = ANY(:path_kinds)
    """
)
_PATH_KINDS_PARAM = list(routing.PATH_KINDS + routing.STAIR_KINDS)


def _safe_rows(sql, params=None):
    """Run a read-only query; return [] on any SQL error (missing table, etc.)."""
    try:
        return list(db.session.execute(sql, params or {}).mappings())
    except SQLAlchemyError:
        db.session.rollback()
        return []


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
    """All named buildings/paths/POIs on the campus map.

    Client-side this is small enough (≲ a few thousand rows on a campus PBF)
    to ship as one JSON payload and filter in the browser.
    """
    features = []

    for row in _safe_rows(_BUILDINGS_SQL):
        lon, lat = row["lon"], row["lat"]
        if lon is None or lat is None:
            continue
        features.append(
            {
                "id": f"way/{row['osm_id']}",
                "osm_id": row["osm_id"],
                "kind": "building",
                "name": row["name"],
                "subtitle": _building_subtitle(row),
                "lon": float(lon),
                "lat": float(lat),
            }
        )

    for row in _safe_rows(_POIS_SQL):
        lon, lat = row["lon"], row["lat"]
        if lon is None or lat is None:
            continue
        features.append(
            {
                "id": f"node/{row['osm_id']}",
                "osm_id": row["osm_id"],
                "kind": "poi",
                "name": row["name"],
                "subtitle": _poi_subtitle(row),
                "lon": float(lon),
                "lat": float(lat),
            }
        )

    # Paths tend to show up as many short segments per named way; collapse
    # duplicates by name so the search list doesn't have ten "Main Walk"
    # entries. Keep the first centroid we saw — good enough for fly-to.
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

    features.sort(key=lambda f: (f["kind"], (f["name"] or "").lower()))
    return jsonify({"features": features, "count": len(features)})


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def _parse_lonlat(prefix: str) -> tuple[float, float]:
    """Pull ?<prefix>_lon / <prefix>_lat off the query string.

    400s on missing or non-numeric values rather than silently defaulting,
    so a typo in the client doesn't quietly route from (0,0).
    """
    try:
        lon = float(request.args[f"{prefix}_lon"])
        lat = float(request.args[f"{prefix}_lat"])
    except (KeyError, TypeError, ValueError):
        abort(400, description=f"missing or invalid {prefix}_lon / {prefix}_lat")
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        abort(400, description=f"{prefix} coordinates out of range")
    return lon, lat


def _compute_route_from_request() -> routing.Route:
    src = _parse_lonlat("from")
    dst = _parse_lonlat("to")
    origin_label = request.args.get("from_label") or None
    destination_label = request.args.get("to_label") or None
    try:
        return routing.shortest_path(
            src,
            dst,
            origin_label=origin_label,
            destination_label=destination_label,
        )
    except routing.RoutingError as err:
        abort(422, description=str(err))


@bp.route("/api/route")
def api_route():
    """Shortest walkable path between two (lon, lat) points.

    Returns a GeoJSON Feature + summary stats so the client can drop it
    straight onto a MapLibre `geojson` source.
    """
    route = _compute_route_from_request()
    return jsonify(
        {
            "distance_m": route.distance_m,
            "duration_s": route.duration_s,
            "geometry": route.to_geojson()["geometry"],
            "feature": route.to_geojson(),
            "trackpoints": [list(p) for p in route.trackpoints],
            "origin_label": route.origin_label,
            "destination_label": route.destination_label,
        }
    )


_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename_part(label: str | None, fallback: str) -> str:
    """Reduce a user-supplied label to ASCII-safe chars for a filename.

    Needed because the label ends up in a ``Content-Disposition`` header,
    which doesn't tolerate quotes, slashes, newlines, or non-ASCII bytes
    without RFC 5987 escaping. We keep it simple: collapse anything not
    in [A-Za-z0-9._-] to underscores, and fall back if the result is
    empty (e.g. a label that was entirely CJK or emoji).
    """
    cleaned = _FILENAME_SAFE.sub("_", (label or "").strip()).strip("._-")
    return cleaned or fallback


@bp.route("/api/route.gpx")
def api_route_gpx():
    """Same route, serialized as a downloadable GPX 1.1 file."""
    route = _compute_route_from_request()
    filename_bits = [
        _safe_filename_part(route.origin_label, "start"),
        "to",
        _safe_filename_part(route.destination_label, "end"),
    ]
    filename = "_".join(filename_bits)[:120] + ".gpx"
    xml = routing.route_to_gpx(
        route,
        name=f"{route.origin_label or 'Start'} → {route.destination_label or 'End'}",
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
    """Graph stats, handy while iterating on the importer."""
    return jsonify(routing.debug_stats())


@bp.route("/api/route/rebuild", methods=["POST"])
def api_route_rebuild():
    """Drop the cached graph so the next /api/route rebuilds from the DB.

    Useful after a fresh scripts/load-osm.sh without restarting Flask.
    """
    routing.reset_graph_cache()
    return jsonify({"ok": True})
