from app.extensions import db
from geoalchemy2 import Geometry

class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)

class Location(db.Model):
    __tablename__ = "locations"

    id = db.Column(db.Integer, primary_key=True)
    kind = db.Column(db.String(50), nullable=False)
    subtype = db.Column(db.String(50), nullable=True)
    orientation = db.Column(db.String(10), nullable=True)
    entrance = db.Column(db.String(100), nullable=True)
    closest_stair = db.Column(db.String(100), nullable=True)
    closest_elevator = db.Column(db.String(100), nullable=True)
    direction_from_connector = db.Column(db.String(200), nullable=True)
    building = db.Column(db.String(100), nullable=False, index=True)
    floor = db.Column(db.String(20), nullable=False)
    room = db.Column(db.String(100), nullable=True)
    notes = db.Column(db.Text, nullable=True)
    loc = db.Column(Geometry(geometry_type="POINT", srid=4326), nullable=False)
