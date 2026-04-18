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
                LOC         GEOMETRY(Point, 4326)
              );
         """)

connection.commit()

print("Table Made")
