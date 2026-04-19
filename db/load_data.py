# db/load_data.py
# Loads all building CSVs into the PostGIS locations table.

import csv
import os

import psycopg2

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://maristmaps:maristmaps@127.0.0.1:5432/maristmaps",
)

connection = psycopg2.connect(DATABASE_URL)
cursor = connection.cursor()

cursor.execute("DROP TABLE IF EXISTS locations CASCADE;")

cursor.execute("""
    CREATE TABLE locations (
        id                         SERIAL PRIMARY KEY,
        kind                       VARCHAR(50) NOT NULL,
        subtype                    VARCHAR(50),
        orientation                VARCHAR(10),
        building                   VARCHAR(100) NOT NULL,
        floor                      VARCHAR(20)  NOT NULL,
        room                       VARCHAR(100),
        notes                      TEXT,
        closest_entrance           VARCHAR(100),
        closest_entrance_elevator  VARCHAR(100),
        closest_stair              VARCHAR(100),
        closest_elevator           VARCHAR(100),
        direction_from_connector   TEXT,
        connections                TEXT,
        loc                        GEOMETRY(Point, 4326) NOT NULL
    );
""")

cursor.execute("CREATE INDEX IF NOT EXISTS locations_building_idx ON locations (building);")
cursor.execute("CREATE INDEX IF NOT EXISTS locations_kind_idx ON locations (kind);")
cursor.execute("CREATE INDEX IF NOT EXISTS locations_loc_idx ON locations USING GIST (loc);")

connection.commit()
print("locations table rebuilt")


def get(row, *keys):
    """First non-empty value for any of the given CSV headers.

    The viz tool evolved its schema over time, so older CSVs may be missing
    columns like 'Connections' or 'Closest stair'. Fall through gracefully
    rather than blowing up on a KeyError.
    """
    for k in keys:
        v = row.get(k)
        if v is not None and v.strip() != "":
            return v.strip()
    return None


buildings = os.path.join(os.path.dirname(os.path.abspath(__file__)), "buildings")
files = [f for f in os.listdir(buildings) if f.lower().endswith(".csv")]

total_rows = 0
for file in sorted(files):
    with open(os.path.join(buildings, file), newline="") as f:
        reader = csv.DictReader(f)
        n = 0
        for row in reader:
            kind = get(row, "Kind")
            if kind is None:
                continue
            try:
                lat = float(row["Latitude"])
                lon = float(row["Longitude"])
            except (KeyError, ValueError):
                continue

            cursor.execute(
                """
                INSERT INTO locations (
                    kind, subtype, orientation, building, floor, room, notes,
                    closest_entrance, closest_entrance_elevator,
                    closest_stair, closest_elevator,
                    direction_from_connector, connections,
                    loc
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, %s,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326));
                """,
                (
                    kind,
                    get(row, "Subtype"),
                    get(row, "Orientation"),
                    get(row, "Building"),
                    get(row, "Floor"),
                    get(row, "Room"),
                    get(row, "Notes"),
                    get(row, "Closest entrance"),
                    get(row, "Closest entrance (elevator)"),
                    get(row, "Closest stair"),
                    get(row, "Closest elevator"),
                    get(row, "Direction from connector"),
                    get(row, "Connections"),
                    lon, lat,
                ),
            )
            n += 1
        print(f"  {file}: {n} rows")
        total_rows += n

connection.commit()
cursor.close()
connection.close()

print(f"Loaded {total_rows} rows across {len(files)} building(s).")
