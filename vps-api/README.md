# Nanogres VPS API

The API binds to `127.0.0.1:8765`; Nginx terminates HTTPS on port `8443`. PostgreSQL remains on
its existing loopback-only port. The Python API uses the system PostgreSQL CLI and runs as the
`postgres` operating-system account, which can connect through the local peer-auth socket.

## Routes

- `GET /healthz` and `GET /v1/overview`
- `GET /v1/databases`, `POST /v1/databases`, `DELETE /v1/databases/{name}`
- `GET /v1/roles`, `POST /v1/roles`
- `GET /v1/backups`, `POST /v1/backups`, `GET /v1/backups/{filename}`
- `GET /v1/activity`

All routes require a server-only bearer token. Database names and role names use lowercase letters,
digits, and underscores. New roles receive only the selected database and table privileges.

## Backups

The timer creates custom-format `pg_dump` files every day near 02:00 UTC. It retains 14 days on
the VPS. Manual backups use the same path. Downloads are proxied by the authenticated Next.js app.
These local backups do not protect against loss of the VPS or its disk; copy them off-server before
storing valuable data there.

The install procedure is documented in `install-vps.md` at the repository root. Do not expose the
TLS listener or put the bearer token into Vercel until the user approves those final access changes.
