import json

coordinates = [[p.longitude, p.latitude] for p in gpx.routes[0].points]

geojson = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": coordinates,
            },
            "properties": {
                "name": gpx.routes[0].name,
            },
        }
    ],
}

with open("route.geojson", "w") as f:
    json.dump(geojson, f)

print(f"\nWrote {len(coordinates)} coordinates to route.geojson")
