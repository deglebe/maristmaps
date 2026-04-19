"""
claude

"""
import csv
from math import asin, cos, radians, sin, sqrt
from pathlib import Path

EARTH_RADIUS_M = 6_371_000


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in meters."""
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * asin(sqrt(a))


def nearest_by_distance(source, candidates):
    """
    Return the `Room` field of the candidate nearest to `source`,
    or None if no candidates exist.
    """
    if not candidates:
        return None
    src_lat = float(source["Latitude"])
    src_lon = float(source["Longitude"])
    closest = min(
        candidates,
        key=lambda c: haversine(
            src_lat, src_lon, float(c["Latitude"]), float(c["Longitude"])
        ),
    )
    return closest["Room"]


def process_file(path: Path) -> None:
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []

    # ensure the target columns exist (harmless if they already do)
    for col in ("Closest stair", "Closest elevator", "Direction from connector"):
        if col not in fieldnames:
            fieldnames.append(col)
            for row in rows:
                row[col] = ""

    # collect the candidate pools once per file
    stairs = [
        r for r in rows
        if r["Kind"] == "connector" and r.get("Subtype") == "stairs"
    ]
    elevators = [
        r for r in rows
        if r["Kind"] == "connector" and r.get("Subtype") == "elevator"
    ]
    entrances = [r for r in rows if r["Kind"] == "entrance"]

    rooms_updated = 0
    connectors_updated = 0

    for row in rows:
        if row["Kind"] == "room":
            row["Closest stair"] = nearest_by_distance(row, stairs) or ""
            row["Closest elevator"] = nearest_by_distance(row, elevators) or ""
            rooms_updated += 1
        elif row["Kind"] == "connector":
            row["Closest entrance"] = nearest_by_distance(row, entrances) or ""
            connectors_updated += 1

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(
        f"{path.name}: "
        f"{rooms_updated} rooms, {connectors_updated} connectors updated"
    )


def main() -> None:
    buildings_dir = Path(__file__).parent / "buildings"
    for csv_path in sorted(buildings_dir.glob("*.csv")):
        process_file(csv_path)


if __name__ == "__main__":
    main()
