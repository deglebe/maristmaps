#!/bin/sh
# maristmaps init: one script to bring up the stack from scratch.
#
# Two modes:
#
#   scripts/init.sh              # LOCAL DEV
#                                #   starts db + martin in docker
#                                #   runs osm2pgsql + db/load_data.py
#                                #   then tells you to `python run.py`
#
#   scripts/init.sh --prod       # PRODUCTION
#                                #   builds all images
#                                #   starts db + martin + init + web + caddy
#                                #   caddy terminates TLS on $DOMAIN
#
# Flags:
#   --reload-osm    force osm2pgsql re-import even if tables exist
#   --skip-osm      skip osm2pgsql entirely (only rebuild locations)
#   --no-build      skip `docker compose build` in prod mode
#   --down          stop and remove the stack (honours --prod)
#   -h, --help      this help
#
# Environment: reads .env (required for --prod). See .env.example.
#
# Exit codes:
#   0   success
#   1   runtime failure (docker missing, db unreachable, build failed, ...)
#   2   bad flag / missing prerequisite

set -eu

usage() {
    sed -n '2,23p' "$0" | sed 's/^# \?//'
}

MODE=dev
ACTION=up
BUILD=1
FORCE_OSM=0
SKIP_OSM=0

while [ $# -gt 0 ]; do
    case "$1" in
        --prod)       MODE=prod; shift ;;
        --dev)        MODE=dev; shift ;;
        --reload-osm) FORCE_OSM=1; shift ;;
        --skip-osm)   SKIP_OSM=1; shift ;;
        --no-build)   BUILD=0; shift ;;
        --down)       ACTION=down; shift ;;
        -h|--help)    usage; exit 0 ;;
        *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    esac
done

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"

log() { printf '[init] %s\n' "$*"; }
die() { printf '[init] error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
docker compose version >/dev/null 2>&1 || die "docker compose plugin is required (docker compose v2)"

compose_files() {
    if [ "$MODE" = "prod" ]; then
        echo "-f docker-compose.yml -f docker-compose.prod.yml"
    else
        echo "-f docker-compose.yml"
    fi
}

# shellcheck disable=SC2046
DC="docker compose $(compose_files)"

if [ "$ACTION" = "down" ]; then
    log "stopping stack (mode=$MODE) ..."
    # shellcheck disable=SC2086
    $DC --profile app --profile init down --remove-orphans
    exit 0
fi

# ----- .env bootstrap ------------------------------------------------------

if [ ! -f .env ]; then
    if [ "$MODE" = "prod" ]; then
        die ".env is missing. Copy .env.example to .env and fill in SECRET_KEY / OPENAI_API_KEY / DOMAIN / ACME_EMAIL before running --prod."
    fi
    log ".env not found; copying from .env.example (fine for local dev — edit it later for real secrets)"
    cp .env.example .env
fi

# ----- dev mode ------------------------------------------------------------

if [ "$MODE" = "dev" ]; then
    log "dev mode: bringing up db + martin ..."
    # shellcheck disable=SC2086
    $DC up -d db martin

    log "running init (osm2pgsql + load_data.py) in a one-shot container ..."
    # shellcheck disable=SC2086
    FORCE_OSM="$FORCE_OSM" SKIP_OSM="$SKIP_OSM" \
        $DC run --rm --build init

    log "restarting martin so it rescans the new planet_osm_* tables ..."
    # shellcheck disable=SC2086
    $DC restart martin >/dev/null

    cat <<EOF

[init] dev bootstrap complete.

  DB:     postgres://maristmaps:maristmaps@127.0.0.1:5432/maristmaps
  Martin: http://127.0.0.1:3000   (catalog: curl http://127.0.0.1:3000/catalog)

Next — run the Flask dev server on the host:

    python run.py             # http://127.0.0.1:5000

Or bring up the full dockerized stack under gunicorn:

    scripts/init.sh --prod

EOF
    exit 0
fi

# ----- prod mode -----------------------------------------------------------

# Sanity-check required vars so we fail fast instead of mid-build.
# shellcheck disable=SC1091
. ./.env
for var in SECRET_KEY OPENAI_API_KEY DOMAIN ACME_EMAIL; do
    eval "val=\${$var:-}"
    if [ -z "$val" ] || [ "$val" = "change-me" ]; then
        die "$var is unset or still 'change-me' in .env"
    fi
done

if [ "$BUILD" = "1" ]; then
    log "building images (web + init) ..."
    # shellcheck disable=SC2086
    $DC --profile app build
fi

log "bringing up full stack (db, martin, init, web, caddy) ..."
# shellcheck disable=SC2086
FORCE_OSM="$FORCE_OSM" SKIP_OSM="$SKIP_OSM" \
    $DC --profile app up -d

# Martin only scans pg_catalog at startup. Compose brings martin and
# init up in parallel (both depend on db), so martin races init and
# caches an empty public schema. `up -d` blocks until init completes
# (web depends on init.service_completed_successfully), so by the time
# we get here it's safe to kick martin and have it see planet_osm_*.
log "restarting martin so its catalog picks up the new planet_osm_* tables ..."
# shellcheck disable=SC2086
$DC restart martin >/dev/null

# Caddy pulls its cert on first HTTPS request; ping it so the first real
# user doesn't eat the ACME handshake latency.
log "waiting 5s for caddy to settle, then poking it ..."
sleep 5
if curl -fsS -o /dev/null --max-time 10 "https://${DOMAIN}/" 2>/dev/null; then
    log "https://${DOMAIN}/ responded OK"
else
    log "https://${DOMAIN}/ not reachable yet (DNS still propagating, or cert issuance in progress)."
    log "  Watch:  docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f caddy"
fi

cat <<EOF

[init] prod stack is up.

  URL:    https://${DOMAIN}
  Tiles:  https://${DOMAIN}/tiles/catalog
  Logs:   docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f web caddy
  Stop:   scripts/init.sh --prod --down

EOF
