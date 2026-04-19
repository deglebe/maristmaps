# Flask + gunicorn image for the maristmaps web service.
#
# Kept as a single stage because psycopg2-binary and Flask don't need any
# compilation toolchain at runtime. If you swap psycopg2-binary for the
# source psycopg2 package, add `build-essential libpq-dev` to a builder
# stage and copy the wheel over.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# libpq5 is the runtime shared library psycopg2-binary links against.
# curl is handy for the healthcheck below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt "gunicorn==23.0.0"

# Non-root user so a container escape doesn't land in root's shell.
RUN useradd --create-home --shell /bin/sh --uid 1000 maristmaps

COPY --chown=maristmaps:maristmaps . .

USER maristmaps

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/ >/dev/null || exit 1

CMD ["gunicorn", "-c", "docker/gunicorn.conf.py", "wsgi:app"]
