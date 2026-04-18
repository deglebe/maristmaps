#!/bin/sh
# Load an OSM PBF into PostGIS via osm2pgsql.
#
# Prerequisites: `docker compose up -d` must already be running so that the
# `db` service (PostGIS 16) is reachable. This script then imports the PBF
# into the four standard osm2pgsql tables (point/line/polygon/roads) which
# Martin serves as vector tiles.
#
# Usage:
#   scripts/load-osm.sh [path/to/file.osm.pbf]
#
# Environment overrides (all optional):
#   PBF_FILE         PBF to import (default: pbf/campus.osm.pbf)
#   PGHOST/PGPORT    Postgres host/port     (default: 127.0.0.1/5432)
#   PGUSER/PGPASSWORD/PGDATABASE            (default: maristmaps/.../maristmaps)
#   OSM2PGSQL_CACHE  --cache in MB          (default: 512)
#   OSM2PGSQL_EXTRA  extra flags appended verbatim to the osm2pgsql invocation
#   OSM2PGSQL_IMAGE  docker image to fall back to (default: iboates/osm2pgsql:latest)
#
# POSIX sh, no bashisms.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

# Pick up DATABASE_URL / PG* defaults from the project's .env if present.
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$PROJECT_DIR/.env"
    set +a
fi

PBF_FILE=${1:-${PBF_FILE:-$PROJECT_DIR/pbf/campus.osm.pbf}}
PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-maristmaps}
PGPASSWORD=${PGPASSWORD:-maristmaps}
PGDATABASE=${PGDATABASE:-maristmaps}
OSM2PGSQL_CACHE=${OSM2PGSQL_CACHE:-512}
OSM2PGSQL_EXTRA=${OSM2PGSQL_EXTRA:-}
OSM2PGSQL_IMAGE=${OSM2PGSQL_IMAGE:-iboates/osm2pgsql:latest}

export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

if [ ! -f "$PBF_FILE" ]; then
    printf 'error: PBF not found: %s\n' "$PBF_FILE" >&2
    exit 1
fi

log() { printf '[load-osm] %s\n' "$*"; }

# Resolve the compose `db` container id (empty string if compose isn't in use).
compose_db_cid() {
    if docker compose version >/dev/null 2>&1; then
        docker compose -f "$PROJECT_DIR/docker-compose.yml" ps -q db 2>/dev/null || true
    elif command -v docker-compose >/dev/null 2>&1; then
        docker-compose -f "$PROJECT_DIR/docker-compose.yml" ps -q db 2>/dev/null || true
    fi
}

# Probe strategies, in order of reliability:
#   1. Container healthcheck status (avoids the docker-proxy-accepts-before-
#      postgres-is-listening race on first boot).
#   2. psql with a real SELECT 1 (does a full auth handshake).
#   3. pg_isready / nc (best-effort TCP probe).
probe_db() {
    _cid=$(compose_db_cid)
    if [ -n "$_cid" ] && command -v docker >/dev/null 2>&1; then
        _status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$_cid" 2>/dev/null || echo unknown)
        case "$_status" in
            healthy) return 0 ;;
            nohealth|unknown) ;; # fall through to other probes
            *) return 1 ;;        # starting / unhealthy
        esac
    fi
    if command -v psql >/dev/null 2>&1; then
        PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
            -d "$PGDATABASE" -tAc 'select 1' >/dev/null 2>&1 && return 0
        return 1
    fi
    if command -v pg_isready >/dev/null 2>&1; then
        pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
            >/dev/null 2>&1 && return 0
        return 1
    fi
    if command -v nc >/dev/null 2>&1; then
        nc -z "$PGHOST" "$PGPORT" >/dev/null 2>&1 && return 0
        return 1
    fi
    # Nothing to probe with; assume caller verified.
    return 0
}

wait_for_db() {
    tries=${DB_WAIT_TRIES:-90}
    while [ "$tries" -gt 0 ]; do
        if probe_db; then
            return 0
        fi
        tries=$((tries - 1))
        sleep 1
    done
    printf 'error: database not reachable at %s:%s after wait\n' "$PGHOST" "$PGPORT" >&2
    return 1
}

log "waiting for PostGIS at $PGHOST:$PGPORT ..."
wait_for_db
log "database is ready"

NPROCS=$(nproc 2>/dev/null || echo 2)

# Flags shared by both host and docker paths.
#   --create       (re)build tables from scratch
#   --slim --drop  use slim tables during import then drop them (smaller DB,
#                  but precludes future diff updates; fine for a static campus)
#   --hstore       stash un-columned tags into a hstore column per row
#   --multi-geometry preserve multipolygons as MULTIPOLYGON instead of splitting
#   default output is EPSG:3857, matching martin/config.yaml
OSM2PGSQL_COMMON="--create --slim --drop --hstore --multi-geometry \
    --number-processes $NPROCS --cache $OSM2PGSQL_CACHE"

run_osm2pgsql() {
    if command -v osm2pgsql >/dev/null 2>&1; then
        log "using host osm2pgsql: $(command -v osm2pgsql)"
        # shellcheck disable=SC2086
        osm2pgsql $OSM2PGSQL_COMMON \
            --host "$PGHOST" --port "$PGPORT" \
            --username "$PGUSER" --database "$PGDATABASE" \
            $OSM2PGSQL_EXTRA \
            "$PBF_FILE"
        return $?
    fi

    if ! command -v docker >/dev/null 2>&1; then
        printf 'error: neither osm2pgsql nor docker is on PATH\n' >&2
        return 1
    fi

    log "osm2pgsql not found on host; falling back to docker image $OSM2PGSQL_IMAGE"

    # Try to discover the compose network of the `db` service so the osm2pgsql
    # container can address it as `db:5432`. If compose isn't available or the
    # service isn't up, fall back to `--network host` and use $PGHOST/$PGPORT.
    _db_cid=$(compose_db_cid)
    _network=""
    if [ -n "$_db_cid" ]; then
        _network=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$_db_cid" 2>/dev/null | awk '{print $1}')
    fi

    if [ -n "$_network" ]; then
        log "attaching to compose network: $_network"
        _net_args="--network $_network"
        _target_host=db
        _target_port=5432
    else
        log "no compose network found; using --network host"
        _net_args="--network host"
        _target_host=$PGHOST
        _target_port=$PGPORT
    fi

    _pbf_dir=$(CDPATH='' cd -- "$(dirname -- "$PBF_FILE")" && pwd)
    _pbf_name=$(basename -- "$PBF_FILE")

    # shellcheck disable=SC2086
    docker run --rm \
        $_net_args \
        -e PGPASSWORD="$PGPASSWORD" \
        -v "$_pbf_dir:/pbf:ro" \
        "$OSM2PGSQL_IMAGE" \
        osm2pgsql $OSM2PGSQL_COMMON \
            --host "$_target_host" --port "$_target_port" \
            --username "$PGUSER" --database "$PGDATABASE" \
            $OSM2PGSQL_EXTRA \
            "/pbf/$_pbf_name"
}

run_osm2pgsql
rc=$?
if [ "$rc" -ne 0 ]; then
    exit "$rc"
fi

# Martin only scans pg_catalog for geometry columns at startup, so new tables
# from osm2pgsql are invisible to a long-running martin. Kick it now so tile
# requests for planet_osm_* resolve instead of 404ing.
#
# Override with SKIP_MARTIN_RESTART=1 if you're running martin outside compose
# or want to restart it yourself.
if [ "${SKIP_MARTIN_RESTART:-0}" = "0" ] && command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
        log "restarting martin to pick up new tables ..."
        docker compose -f "$PROJECT_DIR/docker-compose.yml" restart martin >/dev/null \
            && log "martin restarted" \
            || log "warning: could not restart martin (is it running via compose?)"
    elif command -v docker-compose >/dev/null 2>&1; then
        log "restarting martin to pick up new tables ..."
        docker-compose -f "$PROJECT_DIR/docker-compose.yml" restart martin >/dev/null \
            && log "martin restarted" \
            || log "warning: could not restart martin"
    fi
fi

log "done"
