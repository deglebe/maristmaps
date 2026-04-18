import os

from flask import Flask, g, session

from app.extensions import db
from app.models import User


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
    from app.routes import bp as main_bp

    app.register_blueprint(main_bp)
    # Auth routes are temporarily disabled.
    # app.register_blueprint(auth_bp)

    with app.app_context():
        db.create_all()

    @app.before_request
    def load_logged_in_user():
        uid = session.get("user_id")
        g.user = db.session.get(User, uid) if uid is not None else None

    @app.cli.command("init-db")
    def init_db_command():
        db.create_all()

    return app
