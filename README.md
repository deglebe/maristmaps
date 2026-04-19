# maristmaps

google maps for marist.

A MapLibre + Flask app over a PostGIS/osm2pgsql + martin tile pipeline,
with a langchain-powered nav agent on top.

## Quick start (local dev)

Prereqs: `docker` (with compose v2 plugin), Python 3.11+, and a working
`pip`. The stack itself runs in docker; the Flask dev server runs on
the host so you get autoreload.

```sh
git clone https://github.com/YOUR-FORK/maristmaps.git
cd maristmaps

python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# edit .env: at minimum set OPENAI_API_KEY for the agent

./scripts/init.sh            # db + martin up, osm2pgsql + CSVs loaded
python run.py                # http://127.0.0.1:5000
```

`scripts/init.sh` is idempotent: re-run it any time you add a new PBF
or edit `db/buildings/*.csv`. Pass `--reload-osm` to force an osm2pgsql
re-import.

## Deploy (VPS, HTTPS, subdomain)

```sh
./scripts/init.sh --prod
```

Full walkthrough — DNS, Caddy auto-TLS, day-two ops, troubleshooting —
is in [`deploy.md`](./deploy.md).

## Layout

```
app/               Flask app (routes, models, templates, static)
agent/             Langchain agent (tools, prompts, service)
db/                init-postgis.sql, buildings/*.csv, load_data.py
docker/            Dockerfiles, Caddyfile, gunicorn.conf.py
martin/            martin tile server config
pbf/               OSM PBF extracts (mounted into the init container)
scripts/           init.sh (unified bootstrap), load-osm.sh (legacy)
docker-compose.yml base stack (db + martin + init + web)
docker-compose.prod.yml  adds caddy for HTTPS
run.py             Flask dev server entrypoint (host-side)
wsgi.py            Gunicorn entrypoint (in the web container)
```

## Configuration

Everything lives in `.env`. See `.env.example` for the full annotated
list. In short:

| var                 | purpose                                          |
|---------------------|--------------------------------------------------|
| `SECRET_KEY`        | Flask session signing                            |
| `OPENAI_API_KEY`    | langchain agent                                  |
| `DATABASE_URL`      | postgres conn string (SQLAlchemy form)           |
| `MARTIN_PUBLIC_URL` | tile server URL as the BROWSER sees it           |
| `DOMAIN`            | (prod) subdomain for Caddy TLS                   |
| `ACME_EMAIL`        | (prod) Let's Encrypt registration email          |

## Services

| service | port (dev) | role                                             |
|---------|------------|--------------------------------------------------|
| db      | 5432       | postgis: osm2pgsql tables + `locations`          |
| martin  | 3000       | vector tile server over planet_osm_*             |
| init    | —          | one-shot: osm2pgsql + `db/load_data.py`          |
| web     | 8000       | gunicorn + Flask (prod only; dev uses `run.py`)  |
| caddy   | 80/443     | prod only: TLS + reverse proxy                   |
