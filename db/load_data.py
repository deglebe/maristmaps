# db/load_data.py
# loads all buildings csav's into the PostGIS LOCATIONS table

import csv
import os
import psycopg2

# connect to database
DATABASE_URL = os.environ.get(
        "DATABASE_URL",
        "postgresql://maristmaps:maristmaps@127.0.0.1:5432/maristmaps",
        )

connection = psycopg2.connect(DATABASE_URL)
cursor = connection.cursor()

# create locations table (if not alr created)
cursor.execute("""
              CREATE TABLE IF NOT EXISTS LOCATIONS (
                ID          SERIAL      PRIMARY KEY,
                KIND        VARCHAR(50),
                SUBTYPE     VARCHAR(50),
                ORIENTATION VARCHAR(10),
                ENTRANCE    VARCHAR(100),
                BUILDING    VARCHAR(100),
                FLOOR       VARCHAR(20),
                ROOM        VARCHAR(100),
                NOTES       TEXT,
                CLOSEST_STAIR   VARCHAR(100),
                CLOSEST_ELEVATOR VARCHAR(100),
                DIRECTION_FROM_CONNECTOR    VARCHAR(200),
                LOC         GEOMETRY(Point, 4326)
              );
         """) # 4326 is the standard GPS coord system

connection.commit()
print("Table Made")

# load the csv files to ingest
buildings = os.path.join(os.path.dirname(os.path.abspath(__file__)), "buildings")
files = []
for file in os.listdir(buildings):
    files.append(file)  # please make sure that file is a .csv am to lazy to add a one line check :( --> maybe will later

# go through each file and insert all rows into db table
for file in files:
    with open(os.path.join(buildings, file), newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            # make lat and lon to geometry point
            cursor.execute(
                    """
                    INSERT INTO LOCATIONS (
                        KIND, SUBTYPE,
                        ORIENTATION,
                        ENTRANCE,
                        BUILDING,
                        FLOOR, ROOM, NOTES,
                        CLOSEST_STAIR, CLOSEST_ELEVATOR, DIRECTION_FROM_CONNECTOR,
                        LOC
                    )

                    VALUES               (
                        %s, %s,
                        %s,
                        %s,
                        %s,
                        %s, %s, %s,
                        %s, %s, %s,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                    )
                    """,
                    (
                        row["Kind"],
                        row["Subtype"],
                        row["Orientation"],
                        row["Closest entrance"],
                        row["Building"],
                        row["Floor"],
                        row["Room"],
                        row["Notes"],
                        row.get("Closest stair") or None,
                        row.get("Closest elevator") or None,
                        row.get("Direction from connector") or None,
                        float(row["Longitude"]),
                        float(row["Latitude"]),
                    )
            )
        print(f"Loaded {file}")

#creat a spatial index, should let PostGIS go directly to nearby points
# PostGIS does not need to scan every row (i think, a dude in a youtube video recommended ...)
cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS LOC_IDX
        ON  LOCATIONS
        USING GIST (LOC);
        """
        )

connection.commit()
cursor.close()
connection.close()

print("Loaded Data!")
