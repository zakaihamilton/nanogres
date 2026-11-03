#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi
if ! id postgres >/dev/null 2>&1; then
  echo "The PostgreSQL operating-system account is missing." >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1 || ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  echo "Install PostgreSQL client tools, including pg_restore, before running this script." >&2
  exit 1
fi

if ! command -v rclone >/dev/null 2>&1 || ! command -v repquota >/dev/null 2>&1 || ! command -v setquota >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y rclone quota
fi

install -d -o root -g root -m 0755 /opt/nanogres-api
install -d -o postgres -g postgres -m 0700 /var/backups/nanogres /var/lib/nanogres
install -d -o root -g postgres -m 0750 /etc/nanogres
install -o root -g root -m 0644 "$SOURCE_DIR/api.py" /opt/nanogres-api/api.py
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-api.service" /etc/systemd/system/nanogres-api.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-backup.service" /etc/systemd/system/nanogres-backup.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-backup.timer" /etc/systemd/system/nanogres-backup.timer
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-offsite-backup.service" /etc/systemd/system/nanogres-offsite-backup.service
install -o root -g root -m 0755 "$SOURCE_DIR/nanogres-offsite-backup.py" /opt/nanogres-api/nanogres-offsite-backup.py
install -o root -g root -m 0755 "$SOURCE_DIR/nanogres-quota.py" /usr/local/sbin/nanogres-quota
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-quota.service" /etc/systemd/system/nanogres-quota.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-quota.timer" /etc/systemd/system/nanogres-quota.timer
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-quota.path" /etc/systemd/system/nanogres-quota.path
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-offsite-backup.path" /etc/systemd/system/nanogres-offsite-backup.path
install -o root -g root -m 0644 "$SOURCE_DIR/nginx-nanogres.conf" /etc/nginx/sites-available/nanogres-api
install -o root -g root -m 0644 "$SOURCE_DIR/nginx-nanogres-acme.conf" /etc/nginx/sites-available/nanogres-acme
install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -o root -g root -m 0755 "$SOURCE_DIR/reload-nginx-on-renewal.sh" /etc/letsencrypt/renewal-hooks/deploy/nanogres-reload-nginx

if [ ! -s /etc/nanogres/api.env ]; then
  umask 027
  openssl rand -hex 32 | awk '{ print "NANOGRES_API_TOKEN=" $0 }' > /etc/nanogres/api.env
  chown root:postgres /etc/nanogres/api.env
  chmod 0640 /etc/nanogres/api.env
fi

systemctl daemon-reload
systemctl enable --now nanogres-backup.timer
systemctl enable --now nanogres-quota.timer
systemctl enable --now nanogres-quota.path
systemctl enable --now nanogres-offsite-backup.path
systemctl enable --now nanogres-api.service

echo "Nanogres API is installed and bound to 127.0.0.1:8765."
echo "The HTTPS proxy config is staged but not enabled; no firewall rules were changed."
