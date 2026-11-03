# Nanogres VPS API

The API binds to `127.0.0.1:8765`; Nginx terminates HTTPS on port `8443`. PostgreSQL remains on
its existing loopback-only port. The Python API uses the system PostgreSQL CLI and runs as the
`postgres` operating-system account, which can connect through the local peer-auth socket.

## Routes

- GET /healthz and /v1/overview
- GET /v1/databases, POST /v1/databases, DELETE /v1/databases/{name}
- GET /v1/roles, POST /v1/roles
- GET /v1/backups, POST /v1/backups
- GET /v1/backups/{filename}?offset={bytes}&length={bytes} downloads one range of up to 4 MiB
- POST /v1/backups/{filename}/restore with {"database":"new_name"}
- POST /v1/restore-uploads with {"sizeBytes":123} starts a temporary upload
- PUT /v1/restore-uploads/{id}/chunks/{index} accepts one application/octet-stream chunk up to 4 MiB
- POST /v1/restore-uploads/{id}/complete with {"database":"new_name"} restores the dump
- DELETE /v1/restore-uploads/{id} removes an incomplete upload
- GET /v1/activity

All routes require a server-only bearer token. Database names and role names use lowercase letters,
digits, and underscores. New roles receive only the selected database and table privileges.

## Storage reporting

The API reports total, used, and free space for the filesystem containing PostgreSQL's data
directory. Each user database also receives a dynamic growth-room estimate: by default, 25% of the
currently free data-volume space is divided evenly across user databases. Set
`NANOGRES_DATABASE_GROWTH_PERCENT` in `/etc/nanogres/api.env` to a value from 1 to 50 to change the
percentage. The estimate is recalculated when the dashboard refreshes.

These values are advisory. PostgreSQL has no native per-database size quota, and the VPS API reports
`hardLimitEnforced: false` until operating-system filesystem quotas are configured and verified.
The dashboard labels this state and shows current free disk space so the estimate is not mistaken
for a hard stop.

## Backups

The timer creates custom-format pg_dump files every day near 02:00 UTC. It retains 14 days on the
VPS. Manual backups use the same path. The dashboard transfers downloads and restores in chunks
through its authenticated serverless route, keeping the VPS API address and bearer token out of the
browser. Temporary upload chunks are kept under /var/lib/nanogres/restore-uploads and removed after
a successful restore, an explicit cancellation, or 24 hours.

Restores accept custom-format pg_dump files (.dump or .backup) and always create a new database.
They refuse to overwrite an existing database. If a restore fails, Nanogres removes the new database
when possible and reports when manual cleanup may be needed. PostgreSQL restore files can contain
code chosen by the source database superuser, so restore only files from sources you trust. These
local backups do not protect against loss of the VPS or its disk; copy them off-server before
storing valuable data there.

The install procedure is documented in `install-vps.md` at the repository root. Do not expose the
TLS listener or put the bearer token into Vercel until the user approves those final access changes.
