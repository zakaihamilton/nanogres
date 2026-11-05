# Nanogres VPS API

The API binds to `127.0.0.1:8765`; Nginx terminates HTTPS on port `8443`. PostgreSQL remains on
its existing loopback-only port. The Python API runs as the `postgres` operating-system account and
uses local peer authentication for administration. SQL editor queries and restores connect over
`127.0.0.1` as a restricted, organization-specific PostgreSQL role.

## Routes

- `GET /healthz` and `GET /v1/overview`
- `GET /v1/databases`, `POST /v1/databases`, `DELETE /v1/databases/{name}`
- `POST /v1/databases/{name}/quota` with `{"mode":"auto"}` or `{"mode":"custom","maxBytes":1073741824}`
- `GET /v1/roles`, `POST /v1/roles`
- `POST /v1/query` executes one SQL statement against an organization database
- `GET /v1/backups`, `POST /v1/backups`
- `GET /v1/backups/{filename}?offset={bytes}&length={bytes}` downloads one range up to 4 MiB
- `POST /v1/backups/{filename}/restore` with `{"database":"new_name"}`
- `POST /v1/restore-uploads` with `{"sizeBytes":123}` starts a temporary upload
- `PUT /v1/restore-uploads/{id}/chunks/{index}` accepts an application/octet-stream chunk up to 4 MiB
- `POST /v1/restore-uploads/{id}/complete` with `{"database":"new_name"}` restores the dump
- `DELETE /v1/restore-uploads/{id}` removes an incomplete upload
- `GET /v1/activity`

All management routes require a server-only bearer token. Every `/v1` request also requires the
`X-Nanogres-Organization` header, supplied by the authorized dashboard server. The API hashes that
organization ID into an internal prefix and stores each organization's databases, login roles,
backups, activity, and temporary restores in that scope. Organization database and role names use
lowercase letters, digits, and underscores and can be up to 37 characters; the dashboard displays
logical names while connection snippets use the internal PostgreSQL names. The shared `postgres`
system database is hidden from organization workspaces. New databases are owned by a restricted
organization query role, and `CONNECT` is revoked from `PUBLIC` so one organization's login roles
cannot connect to another organization's databases.

The SQL editor uses the organization's restricted query role instead of the PostgreSQL superuser.
That role can create and modify objects in the organization's databases but cannot create databases,
manage roles, or connect to other organizations' databases. The VPS API token is used to derive its
loopback database password; the password is not returned to the dashboard.

## Storage reporting and limits

The API's `sizeBytes` field uses PostgreSQL's `pg_database_size` for each returned organization
database. The dashboard sums these values for that organization's database total. When a database has
a verified ext4 project quota, `quotaUsedBytes` reports allocated blocks for its primary database
directory and drives its quota meter; otherwise the meter uses `sizeBytes`. Data in additional
tablespaces is included in `pg_database_size` but is outside the hard quota. Shared WAL, backups,
and system files are separate from that organization's database total.

The default growth budget is 25% of free disk after a 1 GiB system reserve. It is shared by all
organizations on the VPS so their combined recommendations cannot over-allocate the disk. Set
`NANOGRES_DATABASE_GROWTH_PERCENT` in `/etc/nanogres/api.env` to a value from 1 to 50. Set
`NANOGRES_DATABASE_QUOTA_RESERVE_BYTES` there to change the reserve. Per-database settings are
stored in `/var/lib/nanogres/database-quota-policy.json` and are changed through the authenticated
API; they are not written to the dashboard or Vercel environment.

When ext4 project quotas are enabled and verified, the root reconciler assigns each user database's
`base/<database-oid>` directory to its own project ID, marks the directory for project inheritance,
and applies a block hard limit. Each database can remain on Auto or request a custom maximum. Custom
requests draw from the shared growth budget first; automatic databases evenly share the remainder.
When custom requests no longer fit after free space changes, their effective growth room is scaled
to fit the budget and Auto databases receive no additional room until the budget recovers. Limits
never go below the blocks already used. The quota timer refreshes every five minutes, and new
databases and quota changes are reconciled immediately. Until the kernel and `repquota` confirm a
database's quota, the dashboard labels its target advisory.

The API rejects a custom maximum below current usage or above the remaining shared growth budget.
Its database response includes the requested cap, effective cap, maximum currently available custom
cap, quota mode, and whether a custom request was reduced to fit. Changes are recorded in the
Nanogres activity log.

Caps cover database files in PostgreSQL's primary tablespace. Shared WAL, system files, backups, and
files in other tablespaces still use the common VPS disk. Keep free-space monitoring enabled.
The root volume must have ext4 `project` and `quota` features plus the `prjquota` mount option.
See `install-vps.md` for the offline maintenance procedure needed on the current VPS.

## Backups

The timer creates custom-format `pg_dump` files daily near 02:00 UTC and retains 14 days locally.
Each daily backup batch and each manual backup queues a copy to the private DigitalOcean Spaces
bucket `nanogres-backups`. The uploader verifies that all retained local dump files exist remotely
with matching sizes. The dashboard considers a successful copy fresh for 36 hours and shows a
warning after a newer failed attempt or when the latest success is older. Its status response
includes freshness (`not-configured`, `pending`, `fresh`, `stale`, or `error`) and age in seconds
without exposing credentials. An optional alert service checks freshness hourly, sends one alert
when copies become stale or an upload fails, reports local scheduled-backup job failures, and sends
recovery notices after a successful verification or backup run. The webhook is disabled unless
`NANOGRES_ALERT_WEBHOOK_URL` is configured; it accepts
HTTPS endpoints, an optional bearer token, and `generic`, `slack`, or `discord` JSON payload formats.
The endpoint and token stay in `/etc/nanogres/backup.env` and are never written to the journal. The
uploader never deletes remote objects, so off-site copies remain after local retention expires.

Install `rclone` and `quota` with `apt-get install rclone quota` if the VPS installer has not done
so. Configure `/etc/nanogres/backup.env` as root with owner `root:postgres` and mode `0640` using a
bucket-scoped Read/Write access key. Keep the secret on the VPS; do not put it in Vercel or source:

```ini
RCLONE_CONFIG_SPACES_TYPE=s3
RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
RCLONE_CONFIG_SPACES_ENV_AUTH=false
RCLONE_CONFIG_SPACES_ACCESS_KEY_ID=...
RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY=...
RCLONE_CONFIG_SPACES_REGION=sfo3
RCLONE_CONFIG_SPACES_ENDPOINT=sfo3.digitaloceanspaces.com
RCLONE_CONFIG_SPACES_ACL=private
NANOGRES_S3_REMOTE=spaces:nanogres-backups/nanogres
# Optional: an HTTPS webhook URL; choose generic, slack, or discord payload shape.
NANOGRES_ALERT_WEBHOOK_URL=https://your-monitor.example/ingest
NANOGRES_ALERT_WEBHOOK_FORMAT=generic
NANOGRES_ALERT_WEBHOOK_BEARER_TOKEN=...
```

No remote lifecycle or deletion rule is configured. This bucket is Cold Storage with a 30-day
minimum storage period; early deletion or replacement may incur minimum-retention charges. Review
current [Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/) and
[lifecycle rules](https://docs.digitalocean.com/products/spaces/how-to/configure-lifecycle-rules/)
before changing remote retention.

The dashboard transfers downloads and restores in chunks through its authenticated serverless
route, keeping the VPS address and bearer token out of the browser. Temporary upload chunks live in
`/var/lib/nanogres/restore-uploads` and are removed after a successful restore, cancellation, or
24 hours. Restores accept custom-format `.dump` and `.backup` files and always create a new database;
they never overwrite an existing one. Restore files can contain commands selected by their source
database superuser, so restore only files you trust.

## Install

Follow `install-vps.md`. The installer does not enable the Nginx proxy or open firewall ports.

## Assign existing databases to an organization

Existing databases and login roles were created before organization scoping and need to be assigned
once. Back up the databases first, pause Nanogres and any applications that connect to them, and
close their remaining sessions. The migration renames existing database and login-role identifiers
internally; passwords and database contents are preserved. Old connections must use the new login
and physical database names shown in Nanogres connection snippets.

Run a dry plan first as the `postgres` operating-system user:

```sh
sudo -u postgres python3 /opt/nanogres-api/api.py --migrate-legacy-organization <PERMINISTER-ORGANIZATION-ID>
```

If the plan is correct, stop the Nanogres API and backup/off-site jobs during the maintenance
window, then apply it:

```sh
sudo systemctl stop \
  nanogres-api.service \
  nanogres-backup.timer nanogres-backup.service \
  nanogres-offsite-backup.path nanogres-offsite-backup.service \
  nanogres-quota.timer nanogres-quota.path nanogres-quota.service
sudo -u postgres python3 /opt/nanogres-api/api.py --migrate-legacy-organization <PERMINISTER-ORGANIZATION-ID> --apply
sudo systemctl start \
  nanogres-api.service nanogres-backup.timer nanogres-offsite-backup.path \
  nanogres-quota.path nanogres-quota.timer
```

The migration stops if a database or login role is longer than the 37-character logical-name
limit, if a scoped name already exists, or if a database still has active connections. Shorten
unsupported legacy names and retry. The installer does not run the migration automatically.
If an application is interrupted after the database rename, rerun the plan and apply command; the
migration finishes securing databases already bearing that organization's prefix.

## Recovery checks

Use these commands on the VPS to review the scheduled job and its logs:

```sh
systemctl list-timers --all 'nanogres-*'
systemctl status nanogres-backup.timer nanogres-offsite-backup.path
journalctl -u nanogres-backup.service -u nanogres-offsite-backup.service --since '2 days ago'
```

`pg_restore --list /var/backups/nanogres/<backup-file>.dump` checks that a local archive can be
read without executing its SQL. This does not replace a restore drill: periodically restore a
trusted archive into a disposable non-production database, verify known data, and remove the test
database. Keep the dashboard's off-site freshness warning and host disk space in your monitoring.
