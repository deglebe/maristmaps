from flask import Blueprint, flash, redirect, render_template, request, session, url_for
from sqlalchemy import select
from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db
from app.models import User

bp = Blueprint("auth", __name__, url_prefix="/auth")


def _normalize_email(raw: str | None) -> str:
    return (raw or "").strip().lower()


@bp.route("/register", methods=("GET", "POST"))
def register():
    if request.method == "POST":
        email = _normalize_email(request.form.get("email"))
        password = request.form.get("password") or ""
        if not email or not password:
            flash("Email and password required.", "error")
        elif "@" not in email:
            flash("Enter a valid email.", "error")
        elif db.session.scalars(select(User).where(User.email == email)).first():
            flash("Email already registered.", "error")
        else:
            db.session.add(
                User(
                    email=email,
                    password_hash=generate_password_hash(password),
                )
            )
            db.session.commit()
            flash("You can sign in now.", "ok")
            return redirect(url_for("auth.login"))
    return render_template("auth/register.html")


@bp.route("/login", methods=("GET", "POST"))
def login():
    if request.method == "POST":
        email = _normalize_email(request.form.get("email"))
        password = request.form.get("password") or ""
        user = db.session.scalars(select(User).where(User.email == email)).first()
        if user is None or not check_password_hash(user.password_hash, password):
            flash("Invalid email or password.", "error")
        else:
            session.clear()
            session["user_id"] = user.id
            return redirect(url_for("main.index"))
    return render_template("auth/login.html")


@bp.route("/logout", methods=("POST",))
def logout():
    session.clear()
    return redirect(url_for("main.index"))
