"""Cached loaders + lookup for OSM-derived map features.

The web search bar and the LLM agent both want to know about every named
thing on the map: campus buildings, off-campus buildings (Home Depot,
Stop & Shop, ...), shops/restaurants/POIs, and named footpaths/roads.

Previously this was inlined in ``app.routes`` and only used to feed the
client-side search drawer. Splitting it out lets the agent fall back to
OSM-known places when the indoor ``locations`` table doesn't have a match.
"""

from __future__ import annotations

import difflib
import json
import threading
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import routing
from app.extensions import db


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
            rows = _apply_overrides_to_building_rows(_safe_rows(_BUILDINGS_SQL))
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
            for r in _safe_rows(_POIS_SQL):
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
            for r in _safe_rows(_PATHS_SQL, {"path_kinds": _PATH_KINDS_PARAM}):
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


def _strip_filler(q: str) -> str:
    """Drop leading articles and trailing generics that voice transcripts add.

    Examples:
      "the home depot"     -> "home depot"
      "sheahan hall"       -> "sheahan hall"  (kept; 'hall' is part of the name)
      "the marist college" -> "marist college"
    """
    s = q
    if s.startswith("the "):
        s = s[4:]
    return s.strip()


# Minimum SequenceMatcher ratio to accept a fuzzy fallback hit. 0.78 catches
# common voice-transcription typos ("Sheehan" vs "Sheahan", "Donelly" vs
# "Donnelly") without dragging in unrelated names.
_FUZZY_MIN_RATIO = 0.78


def _fuzzy_best(query: str, names: list[str]) -> tuple[str, float] | None:
    """Return (best_name, ratio) above ``_FUZZY_MIN_RATIO``, or None."""
    if not query or not names:
        return None
    best_name = None
    best_ratio = 0.0
    for n in names:
        r = difflib.SequenceMatcher(None, query, n).ratio()
        if r > best_ratio:
            best_ratio = r
            best_name = n
    if best_name is None or best_ratio < _FUZZY_MIN_RATIO:
        return None
    return best_name, best_ratio


def find_osm_destination(query: str) -> OsmFeature | None:
    """Best-effort fuzzy match against known OSM places.

    Order of preference:
      1. Exact case-insensitive name match (with/without leading "the").
      2. Name starts with query, OR query starts with name.
      3. Query is a substring of name (or vice versa).
      4. Every whitespace token of query appears in the name.
      5. SequenceMatcher similarity above ``_FUZZY_MIN_RATIO`` (catches
         voice-transcription typos like "Sheehan" → "Sheahan").

    On ties we pick the shortest name (most specific).
    """
    q_raw = _norm(query)
    if not q_raw:
        return None
    q = _strip_filler(q_raw)
    candidates = list_osm_destinations()
    if not candidates:
        return None

    by_norm: dict[str, OsmFeature] = {}
    for f in candidates:
        n = _norm(f.name)
        if n and n not in by_norm:
            by_norm[n] = f

    if q in by_norm:
        return by_norm[q]
    if q_raw in by_norm:
        return by_norm[q_raw]

    def by_len(items: list[OsmFeature]) -> OsmFeature:
        items.sort(key=lambda f: (len(f.name), f.name.lower()))
        return items[0]

    pref = [f for n, f in by_norm.items() if n.startswith(q) or q.startswith(n)]
    if pref:
        return by_len(pref)

    sub = [f for n, f in by_norm.items() if q in n or n in q]
    if sub:
        return by_len(sub)

    tokens = [t for t in q.split() if t]
    if tokens:
        word_hits = [f for n, f in by_norm.items() if all(t in n for t in tokens)]
        if word_hits:
            return by_len(word_hits)

    fuzzy = _fuzzy_best(q, list(by_norm.keys()))
    if fuzzy is not None:
        return by_norm[fuzzy[0]]

    return None
