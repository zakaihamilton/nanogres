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

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] && [ "${ID:-}" != "debian" ]; then
  echo "Automatic PgBouncer installation supports Ubuntu and Debian." >&2
  exit 1
fi
PGDG_CODENAME=${VERSION_CODENAME:-}
if [ -z "$PGDG_CODENAME" ]; then
  echo "The operating-system release codename is missing." >&2
  exit 1
fi
if ! grep -Rqs "apt.postgresql.org/pub/repos/apt" /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  install -d -o root -g root -m 0755 /usr/share/keyrings
  curl --fail --silent --show-error --location \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/keyrings/nanogres-pgdg.asc
  chmod 0644 /usr/share/keyrings/nanogres-pgdg.asc
  printf 'deb [signed-by=/usr/share/keyrings/nanogres-pgdg.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$PGDG_CODENAME" \
    > /etc/apt/sources.list.d/nanogres-pgdg.list
  install -d -o root -g root -m 0755 /etc/apt/preferences.d
  cat > /etc/apt/preferences.d/nanogres-pgbouncer <<'PREFERENCES'
Package: *
Pin: origin apt.postgresql.org
Pin-Priority: 100

Package: pgbouncer
Pin: origin apt.postgresql.org
Pin-Priority: 700
PREFERENCES
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y -t "${PGDG_CODENAME}-pgdg" pgbouncer
PGBOUNCER_VERSION=$(pgbouncer --version | awk 'NR == 1 { print $2 }')
if ! dpkg --compare-versions "$PGBOUNCER_VERSION" ge "1.26.1"; then
  echo "PgBouncer 1.26.1 or newer is required; found ${PGBOUNCER_VERSION:-unknown}." >&2
  exit 1
fi

install -d -o root -g root -m 0755 /opt/nanogres-api
install -d -o postgres -g postgres -m 0700 /var/backups/nanogres /var/lib/nanogres
install -d -o root -g postgres -m 0750 /etc/nanogres
install -d -o root -g postgres -m 0750 /etc/nanogres/pgbouncer
install -o root -g root -m 0644 "$SOURCE_DIR/api.py" /opt/nanogres-api/api.py
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-api.service" /etc/systemd/system/nanogres-api.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-backup.service" /etc/systemd/system/nanogres-backup.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-backup.timer" /etc/systemd/system/nanogres-backup.timer
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-offsite-backup.service" /etc/systemd/system/nanogres-offsite-backup.service
install -o root -g root -m 0755 "$SOURCE_DIR/nanogres-offsite-backup.py" /opt/nanogres-api/nanogres-offsite-backup.py
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-backup-alert.service" /etc/systemd/system/nanogres-backup-alert.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-backup-alert.timer" /etc/systemd/system/nanogres-backup-alert.timer
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-backup-event@.service" /etc/systemd/system/nanogres-backup-event@.service
install -o root -g root -m 0755 "$SOURCE_DIR/nanogres-backup-alert.py" /opt/nanogres-api/nanogres-backup-alert.py
install -o root -g root -m 0755 "$SOURCE_DIR/nanogres-quota.py" /usr/local/sbin/nanogres-quota
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-quota.service" /etc/systemd/system/nanogres-quota.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-quota.timer" /etc/systemd/system/nanogres-quota.timer
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-quota.path" /etc/systemd/system/nanogres-quota.path
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-offsite-backup.path" /etc/systemd/system/nanogres-offsite-backup.path
install -o root -g root -m 0644 "$SOURCE_DIR/nginx-nanogres.conf" /etc/nginx/sites-available/nanogres-api
install -o root -g root -m 0644 "$SOURCE_DIR/nginx-nanogres-acme.conf" /etc/nginx/sites-available/nanogres-acme
install -o root -g root -m 0644 "$SOURCE_DIR/pgbouncer-runtime.ini" /etc/nanogres/pgbouncer-runtime.ini
install -o root -g root -m 0644 "$SOURCE_DIR/pgbouncer-migrations.ini" /etc/nanogres/pgbouncer-migrations.ini
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-pgbouncer-runtime.service" /etc/systemd/system/nanogres-pgbouncer-runtime.service
install -o root -g root -m 0644 "$SOURCE_DIR/nanogres-pgbouncer-migrations.service" /etc/systemd/system/nanogres-pgbouncer-migrations.service
install -o root -g root -m 0755 "$SOURCE_DIR/nanogres-pgbouncer-tls-sync.sh" /usr/local/sbin/nanogres-pgbouncer-tls-sync
install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -o root -g root -m 0755 "$SOURCE_DIR/reload-nginx-on-renewal.sh" /etc/letsencrypt/renewal-hooks/deploy/nanogres-reload-nginx

if [ ! -s /etc/nanogres/api.env ]; then
  umask 027
  openssl rand -hex 32 | awk '{ print "NANOGRES_API_TOKEN=" $0 }' > /etc/nanogres/api.env
  chown root:postgres /etc/nanogres/api.env
  chmod 0640 /etc/nanogres/api.env
fi

PGBOUNCER_AUTH_PASSWORD_FILE=/etc/nanogres/pgbouncer-auth-password
if [ ! -s "$PGBOUNCER_AUTH_PASSWORD_FILE" ]; then
  (
    umask 027
    openssl rand -hex 32 > "$PGBOUNCER_AUTH_PASSWORD_FILE"
  )
  chown root:postgres "$PGBOUNCER_AUTH_PASSWORD_FILE"
  chmod 0640 "$PGBOUNCER_AUTH_PASSWORD_FILE"
fi
PGBOUNCER_AUTH_PASSWORD=$(cat "$PGBOUNCER_AUTH_PASSWORD_FILE")
case "$PGBOUNCER_AUTH_PASSWORD" in
  ''|*[!0-9a-f]*)
    echo "The PgBouncer authentication password file is invalid." >&2
    exit 1
    ;;
esac
if [ "${#PGBOUNCER_AUTH_PASSWORD}" -ne 64 ]; then
  echo "The PgBouncer authentication password must contain 64 lowercase hexadecimal characters." >&2
  exit 1
fi
printf '"nanogres_pgbouncer_auth" "%s"\n' "$PGBOUNCER_AUTH_PASSWORD" > /etc/nanogres/pgbouncer-users.txt
chown root:postgres /etc/nanogres/pgbouncer-users.txt
chmod 0640 /etc/nanogres/pgbouncer-users.txt

runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres <<SQL
DO \$nanogres\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nanogres_pgbouncer_auth'
  ) THEN
    CREATE ROLE nanogres_pgbouncer_auth
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
\$nanogres\$;

SET password_encryption = 'scram-sha-256';
ALTER ROLE nanogres_pgbouncer_auth
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD '$PGBOUNCER_AUTH_PASSWORD';
GRANT CONNECT ON DATABASE postgres TO nanogres_pgbouncer_auth;

CREATE SCHEMA IF NOT EXISTS nanogres_pgbouncer AUTHORIZATION postgres;
ALTER SCHEMA nanogres_pgbouncer OWNER TO postgres;
REVOKE ALL ON SCHEMA nanogres_pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA nanogres_pgbouncer TO nanogres_pgbouncer_auth;

CREATE OR REPLACE FUNCTION nanogres_pgbouncer.get_auth(p_username text)
RETURNS TABLE(username text, password text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS \$function\$
  SELECT role_entry.rolname::text, role_entry.rolpassword::text
  FROM pg_catalog.pg_authid AS role_entry
  WHERE role_entry.rolname::text = p_username
    AND role_entry.rolcanlogin
    AND role_entry.rolpassword IS NOT NULL
    AND (
      role_entry.rolvaliduntil IS NULL
      OR role_entry.rolvaliduntil >= CURRENT_TIMESTAMP
    )
    AND session_user = 'nanogres_pgbouncer_auth'
\$function\$;
ALTER FUNCTION nanogres_pgbouncer.get_auth(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION nanogres_pgbouncer.get_auth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nanogres_pgbouncer.get_auth(text) TO nanogres_pgbouncer_auth;
SQL

systemctl daemon-reload
if [ -s /etc/letsencrypt/live/nanogres.duckdns.org/fullchain.pem ] && [ -s /etc/letsencrypt/live/nanogres.duckdns.org/privkey.pem ]; then
  systemctl disable --now pgbouncer.service >/dev/null 2>&1 || true
  /usr/local/sbin/nanogres-pgbouncer-tls-sync
  systemctl enable nanogres-pgbouncer-runtime.service
  systemctl enable nanogres-pgbouncer-migrations.service
else
  systemctl disable --now nanogres-pgbouncer-runtime.service >/dev/null 2>&1 || true
  systemctl disable --now nanogres-pgbouncer-migrations.service >/dev/null 2>&1 || true
  echo "PgBouncer listeners are staged but disabled until the Nanogres TLS certificate is installed."
fi

systemctl enable --now nanogres-backup.timer
systemctl enable --now nanogres-quota.timer
systemctl enable --now nanogres-quota.path
systemctl enable --now nanogres-offsite-backup.path
systemctl enable --now nanogres-backup-alert.timer
systemctl enable nanogres-api.service
systemctl restart nanogres-api.service

echo "Nanogres API is installed and bound to 127.0.0.1:8765."
echo "PostgreSQL remains private on 127.0.0.1:5432. PgBouncer uses TLS on ports 6432 and 6433 when the certificate is present."
echo "The HTTPS proxy config is staged but not enabled; no firewall rules were changed."
