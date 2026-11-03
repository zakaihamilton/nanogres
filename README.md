<div align="center">
  <img src="src/app/icon.svg" alt="Nanogres icon" width="72" height="72" />
  <h1>Nanogres</h1>
  <p><strong>A private workspace for the Postgres server behind your projects.</strong></p>
  <p>Manage databases, roles, backups, and recovery from one small control panel.</p>
</div>

Nanogres is a self-hosted Postgres management dashboard for personal projects and small teams. The
Next.js app runs on Vercel, while Postgres stays on your VPS. Nanogres gives you a clear view of the
server and a guarded place to handle routine database work.

## What you can do

- **See the state of your server.** Review database sizes, owners, connection counts, server health,
  and recent changes.
- **Keep project access organized.** Create database-scoped read-only and read-write roles, with
  workspace permissions checked on the server for each action.
- **Make and move backups.** Schedule daily backups, download a custom-format dump, or restore a
  trusted `.dump` or `.backup` file into a new database.
- **Review the interface safely.** Open synthetic-data screens, including the getting-started state,
  without signing in or connecting to the VPS.
- **Choose your theme.** Follow the system setting or select light or dark mode.

## How it fits together

```mermaid
flowchart LR
    Browser[Your browser] -->|Perminister session| Dashboard[Next.js dashboard on Vercel]
    Dashboard -->|HTTPS + server-only bearer token| Proxy[Nginx on your VPS]
    Proxy -->|loopback only| API[Nanogres API]
    API -->|local socket| Postgres[(PostgreSQL)]
```

The browser talks only to the dashboard. Vercel server functions check your Perminister session and
workspace permission, then call the VPS API over HTTPS. The VPS API token and Postgres credentials
stay out of browser code. PostgreSQL remains on the VPS and is not exposed as a public database
port.

## Connect your VPS

Use a stable HTTPS origin for the Perminister app client and the VPS API. The default API address in
this project is `https://nanogres.duckdns.org:8443`; Nginx uses port 8443 so an existing TURN service
can continue using its ports.

1. **Install the API on the VPS.** As root, run [`vps-api/install-vps.sh`](vps-api/install-vps.sh).
   The service binds to `127.0.0.1:8765`, creates a random bearer token in
   `/etc/nanogres/api.env`, and enables the daily backup timer. It stages, but does not enable, the
   public HTTPS proxy or firewall rule.
2. **Enable the HTTPS proxy.** Confirm that `nanogres.duckdns.org` resolves to the VPS and that a
   trusted certificate is installed. Review [`vps-api/nginx-nanogres.conf`](vps-api/nginx-nanogres.conf),
   enable the Nginx site, validate the configuration, and reload Nginx. Then allow inbound TCP 8443
   in the VPS firewall. Keep PostgreSQL bound to loopback. The detailed installation notes are in
   [`vps-api/install-vps.md`](vps-api/install-vps.md).
3. **Configure Perminister.** Set the product and organization IDs and create an app client for the
   production dashboard origin. Its callback is `<dashboard-origin>/auth/perminister/callback`.
   Keep public registration disabled for this private dashboard.
4. **Set Vercel Production variables.** Configure the names listed below. Set `NANOGRES_API_URL` to
   the HTTPS API origin and copy the token from `/etc/nanogres/api.env` into
   `NANOGRES_API_TOKEN`. Both values are server-only. Never use a `NEXT_PUBLIC_` prefix for them.
5. **Deploy and sign in.** Deploy the app, sign in through Perminister, then initialize the first
   workspace admin grant if the setup screen requests it.

See [`vps-api/README.md`](vps-api/README.md) for the API routes, backup format, and retention
behavior.

## Develop locally

Requirements: Node.js 24.22 or newer in the 24.x line, and pnpm 12.16 or newer.

```sh
pnpm install
pnpm dev
```

Create an ignored `.env.local` file for local configuration. Add the server-only variable names
below with values from your own Perminister app client and VPS. Do not commit that file. Never add
secrets to source code or variables prefixed with `NEXT_PUBLIC_`.

Open [`http://localhost:3000/ui-preview`](http://localhost:3000/ui-preview) to browse the screens
without authentication. It is enabled only in development, uses clearly labeled synthetic data,
and has no live VPS actions.

For sign-in, configure a Perminister client whose origin exactly matches your local app origin and
whose callback is `<origin>/auth/perminister/callback`. Production and preview origins need their
own matching Perminister configuration when they are used for sign-in.

### Server-only variables

| Variable                      | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `PERMINISTER_URL`             | Perminister service base URL; defaults to `https://www.perminister.com`. |
| `PERMINISTER_CLIENT_ID`       | Nanogres app client ID.                                                  |
| `PERMINISTER_CLIENT_SECRET`   | Server-side app client secret.                                           |
| `PERMINISTER_PRODUCT_ID`      | Product ID used for workspace authorization.                             |
| `PERMINISTER_ORGANIZATION_ID` | Organization that owns the product.                                      |
| `NANOGRES_APP_ORIGIN`         | Exact origin used for sign-in callbacks and cookies.                     |
| `NANOGRES_WORKSPACE_ID`       | Stable ID for this VPS workspace.                                        |
| `NANOGRES_API_URL`            | HTTPS origin for the VPS management API.                                 |
| `NANOGRES_API_TOKEN`          | Bearer token generated by the VPS installer.                             |

## Backups and recovery

Nanogres schedules one custom-format PostgreSQL dump per day and retains 14 days on the VPS. You
can also download a backup to your computer and restore a trusted `.dump` or `.backup` file into a
new database. Restore uploads are transferred in chunks; incomplete uploads are removed after 24
hours. Restores never overwrite an existing database.

The scheduled copies share the VPS disk with PostgreSQL. Download a second copy to protect against
loss of that server or disk. A PostgreSQL dump can contain executable SQL from its source, so restore
only files from sources you trust.

## Repository checks

RepNix provides repository guardrails. Run the checks before proposing a change:

```sh
pnpm health:audit
pnpm health
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

## Project layout

- `src/app/` — Next.js pages, authentication callbacks, and server-side API routes.
- `src/components/dashboard/` — dashboard shell, synthetic preview screens, and live VPS screens.
- `src/lib/` — Perminister authorization and the server-side VPS API client.
- `vps-api/` — Python API, systemd services, Nginx configuration, and VPS installation notes.
