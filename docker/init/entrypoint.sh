#!/bin/sh
# maristmaps init: import OSM PBF via osm2pgsql, then load the building
# CSVs into the `locations` table via db/load_data.py.
#
# Designed to run as a one-shot compose service. Idempotent by default:
# osm2pgsql is skipped if planet_osm_polygon already has rows, and
# load_data.py always drops + rebuilds the locations table so CSV edits
# are picked up on every run.
#
# Environment:
#   PBF_FILE           PBF to import (default /app/pbf/campus.osm.pbf)
#   PGHOST/PGPORT      Postgres host/port (default db/5432)
#   PGUSER/PGPASSWORD
#   PGDATABASE
#   OSM2PGSQL_CACHE    osm2pgsql --cache in MB (default 512)
#   OSM2PGSQL_EXTRA    extra flags appended verbatim
#   FORCE_OSM          set to 1 to re-import even if tables already exist
#   SKIP_OSM           set to 1 to skip osm2pgsql entirely
#   SKIP_LOCATIONS     set to 1 to skip db/load_data.py

set -eu

: "${PBF_FILE:=/app/pbf/campus.osm.pbf}"
: "${PGHOST:=db}"
: "${PGPORT:=5432}"
: "${PGUSER:=maristmaps}"
: "${PGPASSWORD:=maristmaps}"
: "${PGDATABASE:=maristmaps}"
: "${OSM2PGSQL_CACHE:=512}"
: "${OSM2PGSQL_EXTRA:=}"
: "${FORCE_OSM:=0}"
: "${SKIP_OSM:=0}"
: "${SKIP_LOCATIONS:=0}"

export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

log() { printf '[init] %s\n' "$*"; }

log "waiting for postgres at $PGHOST:$PGPORT ..."
tries=60
while ! pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
        echo "[init] error: db not reachable after 60s" >&2
        exit 1
    fi
    sleep 1
done
log "db is ready"

# -- osm2pgsql --------------------------------------------------------------

run_osm2pgsql() {
    if [ ! -f "$PBF_FILE" ]; then
        echo "[init] error: PBF not found: $PBF_FILE" >&2
        exit 1
    fi

    if [ "$FORCE_OSM" = "0" ]; then
        # Idempotency probe: if planet_osm_polygon exists AND has rows,
        # skip the import. Covers the common "compose up after reboot" case.
        has_table=$(PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" \
            -U "$PGUSER" -d "$PGDATABASE" -tAc \
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='planet_osm_polygon'" \
            2>/dev/null || echo 0)
        if [ "$has_table" = "1" ]; then
            row_count=$(PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" \
                -U "$PGUSER" -d "$PGDATABASE" -tAc \
                "SELECT COUNT(*) FROM planet_osm_polygon" 2>/dev/null || echo 0)
            if [ "$row_count" -gt 0 ] 2>/dev/null; then
                log "planet_osm_* already populated ($row_count polygons); skipping osm2pgsql"
                log "  set FORCE_OSM=1 to re-import"
                return 0
            fi
        fi
    fi

    nprocs=$(nproc 2>/dev/null || echo 2)
    log "importing $PBF_FILE via osm2pgsql (cache=${OSM2PGSQL_CACHE}MB, procs=$nprocs) ..."
    # osm2pgsql 2.0 removed --host / --port / --username / --database;
    # connection info is taken from the libpq PG* env vars we exported
    # above (or from -d "postgres://..." if you prefer a URI).
    # shellcheck disable=SC2086
    osm2pgsql \
        --create --slim --drop --hstore --multi-geometry \
        --number-processes "$nprocs" \
        --cache "$OSM2PGSQL_CACHE" \
        -d "$PGDATABASE" \
        $OSM2PGSQL_EXTRA \
        "$PBF_FILE"
    log "osm2pgsql import complete"
}

if [ "$SKIP_OSM" = "1" ]; then
    log "SKIP_OSM=1; skipping osm2pgsql"
else
    run_osm2pgsql
fi

# -- locations table --------------------------------------------------------

if [ "$SKIP_LOCATIONS" = "1" ]; then
    log "SKIP_LOCATIONS=1; skipping db/load_data.py"
else
    log "loading building CSVs via db/load_data.py ..."
    # load_data.py reads DATABASE_URL itself; point it at the compose db.
    DATABASE_URL=${DATABASE_URL:-"postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"} \
        python3 /app/db/load_data.py
fi

# -- tell martin to rescan pg_catalog --------------------------------------
#
# Martin only inspects the schema on startup, so a fresh osm2pgsql import
# isn't visible to an already-running martin. We can't `docker restart`
# from inside a sibling container without mounting the docker socket, so
# we just print a hint. scripts/init.sh restarts martin on the host side.

log "done. If martin was already running, restart it so it picks up the new tables:"
log "    docker compose restart martin"
