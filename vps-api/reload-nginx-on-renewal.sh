#!/bin/sh
set -eu

/usr/local/sbin/nanogres-pgbouncer-tls-sync
systemctl reload nginx
