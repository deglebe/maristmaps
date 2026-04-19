"""Gunicorn config for the maristmaps web service.

Tuned for a small VPS (1-2 vCPU, 1-2 GB RAM):

* `gthread` workers let a single process handle multiple in-flight
  requests while one is blocked on the OpenAI API or PostGIS. With
  `sync` workers a slow agent call would park an entire worker.
* `preload_app=False` so each worker runs `create_app()` itself. That
  matters because `app/__init__.py` spawns daemon threads in
  `warm_cache_async`; if we preloaded in the parent, those threads
  would die at fork() and the first request in each worker would pay
  the full cache-build cost instead of background-warming it.
* `timeout=120` covers worst-case OpenAI/agent turns; raise if you
  start seeing [CRITICAL] WORKER TIMEOUT in the logs.

All knobs are overrideable via env (see docker-compose.yml) so you
don't have to rebuild the image to retune.
"""

import os

bind = "0.0.0.0:" + os.environ.get("PORT", "8000")

workers = int(os.environ.get("GUNICORN_WORKERS", "2"))
worker_class = os.environ.get("GUNICORN_WORKER_CLASS", "gthread")
threads = int(os.environ.get("GUNICORN_THREADS", "4"))

timeout = int(os.environ.get("GUNICORN_TIMEOUT", "120"))
graceful_timeout = int(os.environ.get("GUNICORN_GRACEFUL_TIMEOUT", "30"))
keepalive = int(os.environ.get("GUNICORN_KEEPALIVE", "5"))

preload_app = False

accesslog = "-"
errorlog = "-"
loglevel = os.environ.get("GUNICORN_LOG_LEVEL", "info")

# Caddy terminates TLS and forwards over HTTP; trust X-Forwarded-* so
# url_for(..., _external=True) emits https:// links.
forwarded_allow_ips = os.environ.get("GUNICORN_FORWARDED_ALLOW_IPS", "*")
proxy_allow_ips = os.environ.get("GUNICORN_PROXY_ALLOW_IPS", "*")
