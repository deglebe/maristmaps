import os

from flask import Blueprint, g, render_template

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
    if g.user is None:
        return render_template("index.html")
    return render_template("map.html", map_config=_map_page_config())
