#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi

CERT_DIR=${RENEWED_LINEAGE:-/etc/letsencrypt/live/nanogres.duckdns.org}
if [ ! -s "$CERT_DIR/fullchain.pem" ] || [ ! -s "$CERT_DIR/privkey.pem" ]; then
  echo "Nanogres PgBouncer TLS certificate files are missing in $CERT_DIR." >&2
  exit 1
fi

install -d -o root -g postgres -m 0750 /etc/nanogres/pgbouncer
install -o root -g postgres -m 0640 "$CERT_DIR/fullchain.pem" /etc/nanogres/pgbouncer/server.crt
install -o root -g postgres -m 0640 "$CERT_DIR/privkey.pem" /etc/nanogres/pgbouncer/server.key
systemctl try-reload nanogres-pgbouncer-runtime.service nanogres-pgbouncer-migrations.service
