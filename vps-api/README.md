# Nanogres VPS API

The API binds to `127.0.0.1:8765`; Nginx terminates HTTPS on port `8443`. PostgreSQL remains on
its existing loopback-only port. The Python API runs as the `postgres` operating-system account and
connects through the local peer-auth socket.

## Routes

- `GET /healthz` and `GET /v1/overview`
- `GET /v1/databases`, `POST /v1/databases`, `DELETE /v1/databases/{name}`
- `GET /v1/roles`, `POST /v1/roles`
- `GET /v1/backups`, `POST /v1/backups`
- `GET /v1/backups/{filename}?offset={bytes}&length={bytes}` downloads one range up to 4 MiB
- `POST /v1/backups/{filename}/restore` with `{"database":"new_name"}`
- `POST /v1/restore-uploads` with `{"sizeBytes":123}` starts a temporary upload
- `PUT /v1/restore-uploads/{id}/chunks/{index}` accepts an application/octet-stream chunk up to 4 MiB
- `POST /v1/restore-uploads/{id}/complete` with `{"database":"new_name"}` restores the dump
- `DELETE /v1/restore-uploads/{id}` removes an incomplete upload
- `GET /v1/activity`

All routes require a server-only bearer token. Database and role names use lowercase letters,
digits, and underscores. New roles receive only the selected database and table privileges.

## Storage reporting and limits

The API reports total, used, and free space for PostgreSQL's data filesystem. It estimates growth
room as a percentage of free space shared evenly across user databases. The default is 25%; set
`NANOGRES_DATABASE_GROWTH_PERCENT` in `/etc/nanogres/api.env` to a value from 1 to 50.

When ext4 project quotas are enabled and verified, the root reconciler assigns each user database's
`base/<database-oid>` directory to its own project ID, marks the directory for project inheritance,
and applies a block hard limit. The cap is the current project usage plus its share of the configured
percentage of free volume, while reserving 1 GiB for the system. The quota timer refreshes every
five minutes, and new databases are reconciled immediately before Nanogres reports their hard limit.
Until the kernel and `repquota` confirm a database's quota, the dashboard labels its target advisory.

Caps cover database files in PostgreSQL's primary tablespace. Shared WAL, system files, backups, and
files in other tablespaces still use the common VPS disk. Keep free-space monitoring enabled.
The root volume must have ext4 `project` and `quota` features plus the `prjquota` mount option.
See `install-vps.md` for the offline maintenance procedure needed on the current VPS.

## Backups

The timer creates custom-format `pg_dump` files daily near 02:00 UTC and retains 14 days locally.
Each daily backup batch and each manual backup queues a copy to the private DigitalOcean Spaces
bucket `nanogres-backups`. The uploader verifies that all retained local dump files exist remotely
with matching sizes. It never deletes remote objects, so off-site copies remain after local retention
expires. The dashboard reports the last successful upload and the retained files verified.

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
