import os

from flask import Flask, g, session

from app import osm_features, routing
from app.extensions import db
from app.models import User
from app.routes import bp as main_bp


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
    app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg2://maristmaps:maristmaps@127.0.0.1:5432/maristmaps",
    )
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

    db.init_app(app)

    # from app.auth import bp as auth_bp
    app.register_blueprint(main_bp)
    # Auth routes are temporarily disabled.
    # app.register_blueprint(auth_bp)

    from agent.service import init_agent

    init_agent(app)

    with app.app_context():
        db.create_all()

    # Build the route graph and OSM feature caches so the first /api/route and
    # /api/features calls don't pay the cost. Default is async; set
    # ROUTING_WARM_SYNC=1 to block startup until the routing graph is ready.
    if os.environ.get("ROUTING_WARM_SYNC", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    ):
        with app.app_context():
            routing.get_graph()
    else:
        # Under werkzeug's reloader this runs once in the parent and again in
        # the re-exec'd child; the parent's daemon thread dies with it.
        routing.warm_cache_async(app)
    osm_features.warm_cache_async(app)

    @app.before_request
    def load_logged_in_user():
        uid = session.get("user_id")
        g.user = db.session.get(User, uid) if uid is not None else None

    @app.cli.command("init-db")
    def init_db_command():
        db.create_all()

    return app
