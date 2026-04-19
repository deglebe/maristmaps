"""Cached loaders + lookup for OSM-derived map features.

The web search bar and the LLM agent both want to know about every named
thing on the map: campus buildings, off-campus buildings (Home Depot,
Stop & Shop, ...), shops/restaurants/POIs, and named footpaths/roads.

Previously this was inlined in ``app.routes`` and only used to feed the
client-side search drawer. Splitting it out lets the agent fall back to
OSM-known places when the indoor ``locations`` table doesn't have a match.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import routing
from app.extensions import db

_log = logging.getLogger(__name__)


_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_BUILDING_OVERRIDES_PATH = _DATA_DIR / "building_name_overrides.json"


@dataclass(frozen=True)
class OsmFeature:
    osm_id: int
    kind: str  # "building" | "poi" | "path"
    name: str
    subtitle: str
    lon: float
    lat: float


# --- SQL ---------------------------------------------------------------------

# All three queries get the shared ST_DWithin clipper from routing so
# we don't hydrate all of Poughkeepsie on first /api/features call.


def _buildings_sql():
    return text(
        """
        SELECT osm_id, name, building, amenity,
               ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
               ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
        FROM planet_osm_polygon
        WHERE building IS NOT NULL AND name IS NOT NULL AND trim(name) <> ''
        """
        + routing.area_filter_sql()
    )


def _pois_sql():
    return text(
        """
        SELECT osm_id, name, amenity, shop, tourism, leisure, office,
               ST_X(ST_Transform(way, 4326)) AS lon,
               ST_Y(ST_Transform(way, 4326)) AS lat
        FROM planet_osm_point
        WHERE name IS NOT NULL AND trim(name) <> ''
          AND (amenity IS NOT NULL OR shop IS NOT NULL OR tourism IS NOT NULL
               OR leisure IS NOT NULL OR office IS NOT NULL)
        """
        + routing.area_filter_sql()
    )


def _paths_sql():
    return text(
        """
        SELECT osm_id, name, highway,
               ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
               ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
        FROM planet_osm_line
        WHERE name IS NOT NULL AND trim(name) <> ''
          AND highway = ANY(:path_kinds)
        """
        + routing.area_filter_sql()
    )


_PATH_KINDS_PARAM = list(routing.PATH_KINDS + routing.STAIR_KINDS)

_BUILDING_POLYGON_BY_OSM_SQL = text(
    """
    SELECT osm_id, name, building, amenity,
           ST_X(ST_Transform(ST_Centroid(way), 4326)) AS lon,
           ST_Y(ST_Transform(ST_Centroid(way), 4326)) AS lat
    FROM planet_osm_polygon
    WHERE osm_id = :osm_id AND building IS NOT NULL
    LIMIT 1
    """
)


# --- subtitle formatters -----------------------------------------------------


def _building_subtitle(row) -> str:
    parts: list[str] = []
    amenity = row["amenity"]
    if amenity:
        parts.append(str(amenity).replace("_", " "))
    btype = row["building"]
    if btype and btype != "yes":
        parts.append(str(btype).replace("_", " "))
    return " · ".join(parts) or "Building"


def _poi_subtitle(row) -> str:
    for key in ("amenity", "shop", "tourism", "leisure", "office"):
        val = row[key]
        if val:
            return str(val).replace("_", " ")
    return "Point of interest"


def _path_subtitle(row) -> str:
    highway = row["highway"] or "path"
    return str(highway).replace("_", " ")


# --- DB helpers --------------------------------------------------------------


def _safe_rows(sql, params=None) -> list:
    try:
        return list(db.session.execute(sql, params or {}).mappings())
    except SQLAlchemyError:
        db.session.rollback()
        return []


def _safe_one(sql, params) -> dict | None:
    try:
        row = db.session.execute(sql, params).mappings().first()
        return dict(row) if row else None
    except SQLAlchemyError:
        db.session.rollback()
        return None


# --- caches ------------------------------------------------------------------


_LOCK = threading.Lock()
_BUILDINGS: list[OsmFeature] | None = None
_POIS: list[OsmFeature] | None = None
_PATHS: list[OsmFeature] | None = None
_OVERRIDES: dict[str, str] | None = None


def _load_overrides_from_disk() -> dict[str, str]:
    if not _BUILDING_OVERRIDES_PATH.is_file():
        return {}
    try:
        raw = json.loads(_BUILDING_OVERRIDES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        ks = str(k).strip()
        if ks.startswith("__"):
            continue
        if v is None or str(v).strip() == "":
            continue
        out[ks] = str(v).strip()
    return out


def building_name_overrides() -> dict[str, str]:
    """OSM polygon ``osm_id`` (string) → display name override."""
    global _OVERRIDES
    if _OVERRIDES is None:
        _OVERRIDES = _load_overrides_from_disk()
    return _OVERRIDES


def _apply_overrides_to_building_rows(rows: list[dict]) -> list[dict]:
    """Rename matched OSM buildings and synthesize rows for overridden
    polygons whose name was empty in OSM (so a query like 'building IS NOT
    NULL AND name IS NOT NULL' wouldn't have surfaced them).
    """
    overrides = building_name_overrides()
    if not overrides:
        return [dict(r) for r in rows]
    by_osm: dict[int, dict] = {int(r["osm_id"]): dict(r) for r in rows}
    extra: list[dict] = []
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
        row = dict(row)
        row["name"] = label
        extra.append(row)
    out = list(by_osm.values())
    out.extend(extra)
    return out


def load_osm_buildings() -> list[OsmFeature]:
    global _BUILDINGS
    if _BUILDINGS is not None:
        return _BUILDINGS
    with _LOCK:
        if _BUILDINGS is None:
            rows = _apply_overrides_to_building_rows(
                _safe_rows(_buildings_sql(), routing.area_filter_params())
            )
            out: list[OsmFeature] = []
            for r in rows:
                lon, lat = r.get("lon"), r.get("lat")
                if lon is None or lat is None:
                    continue
                out.append(OsmFeature(
                    osm_id=int(r["osm_id"]),
                    kind="building",
                    name=str(r["name"]),
                    subtitle=_building_subtitle(r),
                    lon=float(lon),
                    lat=float(lat),
                ))
            _BUILDINGS = out
    return _BUILDINGS


def load_osm_pois() -> list[OsmFeature]:
    global _POIS
    if _POIS is not None:
        return _POIS
    with _LOCK:
        if _POIS is None:
            out: list[OsmFeature] = []
            for r in _safe_rows(_pois_sql(), routing.area_filter_params()):
                lon, lat = r.get("lon"), r.get("lat")
                if lon is None or lat is None:
                    continue
                out.append(OsmFeature(
                    osm_id=int(r["osm_id"]),
                    kind="poi",
                    name=str(r["name"]),
                    subtitle=_poi_subtitle(r),
                    lon=float(lon),
                    lat=float(lat),
                ))
            _POIS = out
    return _POIS


def load_osm_paths() -> list[OsmFeature]:
    """Named walkable highways (one entry per distinct name)."""
    global _PATHS
    if _PATHS is not None:
        return _PATHS
    with _LOCK:
        if _PATHS is None:
            seen: set[str] = set()
            out: list[OsmFeature] = []
            path_params = {"path_kinds": _PATH_KINDS_PARAM, **routing.area_filter_params()}
            for r in _safe_rows(_paths_sql(), path_params):
                name = r.get("name")
                if not name or name in seen:
                    continue
                lon, lat = r.get("lon"), r.get("lat")
                if lon is None or lat is None:
                    continue
                seen.add(name)
                out.append(OsmFeature(
                    osm_id=int(r["osm_id"]),
                    kind="path",
                    name=str(name),
                    subtitle=_path_subtitle(r),
                    lon=float(lon),
                    lat=float(lat),
                ))
            _PATHS = out
    return _PATHS


def reset_osm_cache() -> None:
    global _BUILDINGS, _POIS, _PATHS, _OVERRIDES
    with _LOCK:
        _BUILDINGS = None
        _POIS = None
        _PATHS = None
        _OVERRIDES = None


def warm_cache_async(app) -> None:
    """Populate the building / poi / path caches in the background so
    the first /api/features request returns immediately.
    """
    if _BUILDINGS is not None and _POIS is not None and _PATHS is not None:
        return

    def _run():
        try:
            with app.app_context():
                load_osm_buildings()
                load_osm_pois()
                load_osm_paths()
        except Exception:  # noqa: BLE001
            _log.exception("osm_features warm-up failed; will retry on first request")

    t = threading.Thread(target=_run, name="osm-features-warm", daemon=True)
    t.start()


# --- search dict (for /api/features) -----------------------------------------


def feature_to_search_dict(f: OsmFeature) -> dict:
    """Shape the client expects from ``/api/features``.

    Buildings + named paths come from polygon/line tables (``way/<osm_id>``);
    POIs come from the point table (``node/<osm_id>``).
    """
    prefix = "node/" if f.kind == "poi" else "way/"
    return {
        "id": f"{prefix}{f.osm_id}",
        "osm_id": f.osm_id,
        "kind": f.kind,
        "name": f.name,
        "subtitle": f.subtitle,
        "lon": f.lon,
        "lat": f.lat,
    }


# --- agent-facing lookup -----------------------------------------------------


def list_osm_destinations() -> list[OsmFeature]:
    """Buildings + POIs deduped by lowercase name (buildings win on conflict).

    Used by the agent to resolve free-text place names like "Home Depot"
    into a (lon, lat) endpoint when the indoor locations table has no
    matching building.
    """
    seen: dict[str, OsmFeature] = {}
    for f in load_osm_buildings():
        key = f.name.strip().lower()
        if key and key not in seen:
            seen[key] = f
    for f in load_osm_pois():
        key = f.name.strip().lower()
        if key and key not in seen:
            seen[key] = f
    return list(seen.values())


def _norm(s: str) -> str:
    return " ".join((s or "").strip().lower().split())


def find_osm_destination(query: str) -> OsmFeature | None:
    """Best-effort fuzzy match against known OSM places.

    Order of preference:
      1. Exact case-insensitive name match.
      2. Name starts with query, OR query starts with name.
      3. Query is a substring of name (or vice versa).
      4. Every whitespace token of query appears in the name.

    On ties we pick the shortest name (most specific).
    """
    q = _norm(query)
    if not q:
        return None
    candidates = list_osm_destinations()
    if not candidates:
        return None

    for f in candidates:
        if _norm(f.name) == q:
            return f

    def by_len(items: list[OsmFeature]) -> OsmFeature:
        items.sort(key=lambda f: (len(f.name), f.name.lower()))
        return items[0]

    pref = [f for f in candidates if _norm(f.name).startswith(q) or q.startswith(_norm(f.name))]
    if pref:
        return by_len(pref)

    sub = [f for f in candidates if q in _norm(f.name) or _norm(f.name) in q]
    if sub:
        return by_len(sub)

    tokens = [t for t in q.split() if t]
    if tokens:
        word_hits = [f for f in candidates if all(t in _norm(f.name) for t in tokens)]
        if word_hits:
            return by_len(word_hits)

    return None
