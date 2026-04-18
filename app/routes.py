import json
import os
from pathlib import Path

from flask import Blueprint, jsonify, render_template
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.extensions import db

bp = Blueprint("main", __name__)

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

# Paths = pedestrian/bike/foot ways (not vehicle roads). Matches the
# PATH_KINDS + STAIR_KINDS set rendered by the map style.
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
      AND highway IN (
          'footway', 'path', 'pedestrian', 'cycleway',
          'track', 'bridleway', 'corridor', 'steps'
      )
    """
)

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


def _safe_rows(sql):
    """Run a read-only query; return [] on any SQL error (missing table, etc.)."""
    try:
        return list(db.session.execute(sql).mappings())
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
    for row in _safe_rows(_PATHS_SQL):
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
