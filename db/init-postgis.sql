-- Extensions required for osm2pgsql + Martin vector tiles.
-- PostGIS provides geometry/geography types and the ST_* spatial functions.
-- hstore lets osm2pgsql --hstore stash arbitrary OSM tags as key/value pairs
-- so we can query uncommon attributes without creating a column for each one.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;

-- osm2pgsql emits these four tables with the default pgsql output style:
--   planet_osm_point    OSM nodes with tags (POIs: amenity, shop, name, ...)
--   planet_osm_line     OSM ways w/ tags (roads, paths, rails, barriers, ...)
--   planet_osm_polygon  closed ways/relations as areas (buildings, parks, ...)
--   planet_osm_roads    subset of planet_osm_line for low-zoom road rendering
-- Geometry column is `way` in SRID 3857 (Web Mercator) so Martin can serve
-- them directly as MVT without reprojecting per request.
--
-- The tables themselves are created by `scripts/load-osm.sh` on first run.
