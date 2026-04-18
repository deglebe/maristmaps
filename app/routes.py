import os

from flask import Blueprint, render_template

bp = Blueprint("main", __name__)


def _map_page_config():
    base = os.environ.get("MARTIN_PUBLIC_URL", "http://127.0.0.1:3000").rstrip("/")
    source_id = os.environ.get("MARTIN_SOURCE_ID", "planet_osm_line")
    tile_url = f"{base}/{source_id}/{{z}}/{{x}}/{{y}}"
    return {
        "tileUrl": tile_url,
        "vectorLayer": os.environ.get("MARTIN_VECTOR_LAYER", "planet_osm_line"),
        "center": [
            float(os.environ.get("MAP_CENTER_LON", "-73.9857")),
            float(os.environ.get("MAP_CENTER_LAT", "40.7484")),
        ],
        "zoom": float(os.environ.get("MAP_ZOOM", "14")),
    }


@bp.route("/")
def index():
    return render_template("index.html", map_config=_map_page_config())
