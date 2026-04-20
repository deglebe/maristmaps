# Deploying maristmaps

End-to-end: fresh clone on a VPS -> HTTPS on a subdomain. Total time
is usually 10-15 minutes once DNS has propagated.

The stack:

```
           ┌───────────────── VPS (Linux, docker) ───────────────────┐
  :443 ─── │  caddy  ─┬── /tiles/*  ──→  martin:3000                 │
  :80  ─── │          └── /*         ──→  web:8000 (gunicorn+flask)  │
           │                                    │                    │
           │                                    └──→ db:5432 (postgis)│
           │                                                          │
           │          init (one-shot): osm2pgsql + db/load_data.py    │
           └──────────────────────────────────────────────────────────┘
```

Everything runs under `docker compose`. No system-wide packages besides
docker itself. Caddy handles TLS automatically via Let's Encrypt; you
never touch certbot.

---

## 1. Prerequisites

### On the VPS

- A Linux VM you control (Debian/Ubuntu tested; anything systemd works).
- Ports **80** and **443** open inbound (TCP, and UDP/443 for HTTP/3 if
  your provider allows it -- optional).
- At least **1 GB RAM** and **~6 GB disk** for the `postgis` volume +
  images. 2 GB RAM is the comfortable minimum once the agent starts
  answering questions.
- **Docker Engine 24+** with the `compose` v2 plugin.

  On Debian/Ubuntu:

  ```sh
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"       # re-login after this
  ```

### DNS

Point the subdomain you want to use at the VPS **before** you start the
prod stack -- Caddy needs the A/AAAA record in place to solve the ACME
HTTP-01 challenge.

```
maps.example.com.   A    203.0.113.42      (your VPS IPv4)
maps.example.com.   AAAA 2001:db8::42      (your VPS IPv6, if any)
```

Verify with `dig +short maps.example.com` from your laptop before
continuing.

---

## 2. Clone and configure

```sh
git clone https://github.com/YOUR-FORK/maristmaps.git
cd maristmaps
cp .env.example .env
```

Edit `.env` and set at minimum:

| var                | what                                                                |
|--------------------|---------------------------------------------------------------------|
| `SECRET_KEY`       | `openssl rand -hex 32`                                              |
| `OPENAI_API_KEY`   | project key with a monthly spend cap                                |
| `DOMAIN`           | the subdomain you just DNS'd, e.g. `maps.example.com`               |
| `ACME_EMAIL`       | where Let's Encrypt sends expiry notices                            |
| `POSTGRES_PASSWORD`| strong random string                                                |
| `MARTIN_PUBLIC_URL`| set to `https://${DOMAIN}/tiles`                                    |

`MARTIN_PUBLIC_URL` matters: the Flask server embeds it verbatim into
the page so the browser knows where to fetch vector tiles from. In prod
the browser hits `https://${DOMAIN}/tiles/...` and Caddy proxies it to
the martin container.

Make sure the PBF you want to serve is at `pbf/campus.osm.pbf` (or set
`PBF_BASENAME` in `.env`). The file under `pbf/` in this repo is the
default Marist College campus extract.

---

## 3. Bring the stack up

```sh
./scripts/init.sh --prod
```

What that does:

1. Sanity-checks `.env` (bails if `SECRET_KEY` / `OPENAI_API_KEY` /
   `DOMAIN` / `ACME_EMAIL` are unset or still `change-me`).
2. Builds the `web` and `init` images (`docker compose build`).
3. Starts `db` and waits for its healthcheck.
4. Runs the **init** container once: `osm2pgsql` imports the PBF into
   `planet_osm_*`, then `db/load_data.py` rebuilds the `locations`
   table from `db/buildings/*.csv`. Idempotent -- it skips the osm2pgsql
   step on later runs unless you pass `--reload-osm` or set `FORCE_OSM=1`.
5. Starts `martin` (tile server) and `web` (gunicorn).
6. Starts `caddy`, which grabs a Let's Encrypt cert on first HTTPS
   request and serves your site.

First run takes a few minutes: image pulls + osm2pgsql + ACME handshake.
Subsequent restarts are seconds.

### Verifying

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps
curl -fsS -o /dev/null -w '%{http_code}\n' https://$DOMAIN/
curl -fsS https://$DOMAIN/tiles/catalog | head
```

Expected:

- `docker compose ps` shows `db`, `martin`, `init` (Exit 0), `web`,
  `caddy` all healthy/running.
- `/` returns 200.
- `/tiles/catalog` returns a JSON list of tables including
  `planet_osm_polygon`, `planet_osm_line`, `planet_osm_point`.

Open `https://maps.example.com/` in a browser -- you should see the map.

---

## 4. Day-two operations

### Logs

```sh
DC='docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml'

$DC logs -f web            # gunicorn + flask + agent
$DC logs -f caddy          # TLS handshakes, access log
$DC logs -f martin         # tile requests
$DC logs -f db             # postgres
```

### Restart just one thing

```sh
$DC restart web            # after pulling code (see "Update" below)
$DC restart martin         # after manually editing martin/config.yaml
```

### Update to a new commit

```sh
git pull
./scripts/init.sh --prod   # rebuilds images, runs init (idempotent),
                           # rolling-restarts web / caddy
```

`init` won't re-import the PBF unless you pass `--reload-osm`; CSV
edits in `db/buildings/` always get picked up because `load_data.py`
drops and recreates the `locations` table every run.

### Swap the PBF

```sh
cp path/to/new.osm.pbf pbf/campus.osm.pbf
./scripts/init.sh --prod --reload-osm
$DC restart martin         # so it rescans pg_catalog
```

### Stop everything

```sh
./scripts/init.sh --prod --down
```

Data persists in the `postgres_data` and `caddy_data` volumes. Add
`docker compose -f ... down -v` if you genuinely want to wipe the DB.

### Back up the database

```sh
docker compose exec db pg_dump -U maristmaps -d maristmaps \
    | gzip > backup-$(date +%F).sql.gz
```

---

## 5. Troubleshooting

### Caddy is stuck trying to issue a cert

```sh
$DC logs caddy | tail -n 50
```

Common causes:

- **DNS not propagated.** `dig $DOMAIN` from a different network should
  return your VPS's IP. Wait, then `$DC restart caddy`.
- **Port 80 blocked.** ACME HTTP-01 needs inbound 80. Check your VPS
  provider's firewall + any host-level `ufw`.
- **Rate-limited by Let's Encrypt.** You probably iterated too much on
  the Caddyfile against prod ACME. Uncomment the `acme_ca ... staging`
  line in `docker/Caddyfile` until you're happy, then switch back.

### `web` keeps restarting

```sh
$DC logs web | tail -n 100
```

- `OPENAI_API_KEY is not set` -> `.env` not loaded; make sure you ran
  `scripts/init.sh --prod` from the project root.
- `sqlalchemy.exc.OperationalError: connection refused` -> `init` hasn't
  finished / failed. Check `$DC logs init`.
- `gunicorn ... WORKER TIMEOUT` -> an agent call took >120s. Bump
  `GUNICORN_TIMEOUT` in `.env` and restart web.

### Map loads but tiles are blank

- Hit `https://$DOMAIN/tiles/catalog` -- if `planet_osm_polygon` is
  missing, the init step didn't complete. `$DC logs init`.
- If the catalog is fine but the browser 404s on tiles, your
  `MARTIN_PUBLIC_URL` in `.env` is probably still `http://127.0.0.1:3000`.
  Set it to `https://${DOMAIN}/tiles` and `$DC restart web`.
- After an `osm2pgsql` re-import, martin caches its old schema until
  it's restarted: `$DC restart martin`.

### `planet_osm_*` empty after init

The init container skips osm2pgsql if those tables already exist (so
`docker compose up` after a reboot doesn't re-import). Force a reload:

```sh
FORCE_OSM=1 ./scripts/init.sh --prod
# or just:
./scripts/init.sh --prod --reload-osm
```

---

## 6. Security notes

- `db` (5432) and `martin` (3000) are bound to `127.0.0.1` on the host,
  so they're only reachable from the VPS itself -- the public-facing
  surface is `caddy` on 80/443 and nothing else.
- Caddy sets HSTS for 6 months once HTTPS is working. If you're still
  iterating on DNS, comment the `Strict-Transport-Security` header in
  `docker/Caddyfile` until you're sure.
- Rotate `SECRET_KEY` if it leaks -- existing signed-cookie sessions
  will be invalidated, which is the desired outcome.
- The agent calls OpenAI from the web container. Use a scoped project
  key with a monthly budget, not your personal key.

---

## 7. Local development (for comparison)

```sh
./scripts/init.sh          # db + martin + init, leaves flask for you
python run.py              # http://127.0.0.1:5000
```

See `README.md` for the dev workflow in detail.
