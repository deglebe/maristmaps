# One-shot image that runs osm2pgsql + db/load_data.py against the
# running PostGIS container. Built from debian:12-slim so we get
# osm2pgsql from the distro and still have python3 for load_data.py.

FROM debian:13-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        osm2pgsql \
        postgresql-client \
        python3 \
        python3-psycopg2 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY docker/init/entrypoint.sh /usr/local/bin/maristmaps-init
RUN chmod +x /usr/local/bin/maristmaps-init

ENTRYPOINT ["/usr/local/bin/maristmaps-init"]
