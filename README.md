# Nanogres

Nanogres is a private Next.js control panel for Postgres databases on the CloudFanatic VPS. The web
app runs on Vercel. The VPS management API will be the only service that can reach Postgres; the
database port is not exposed to the browser.

## Stack

- Next.js App Router and TypeScript
- CSS Modules for application screens and responsive layout
- System, light, and dark themes
- Perminister for shared identity and server-side permission checks
- `ui-preview-kit` for a local `/ui-preview` route with synthetic data and simulated controls
- RepNix for repository health guardrails

## Local development

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000/ui-preview` to review the screens without signing in. The route is
development-only and returns 404 in production. Its fixtures are synthetic; its actions do not call
the VPS or change data.

The real dashboard requires a Perminister app client. Set its app origin to the exact Nanogres app
origin and use the callback URL `<origin>/auth/perminister/callback`. For local development,
Perminister accepts `http://localhost` as an origin. Put the client secret in `.env.local` and in
Vercel's server-side environment variables; never expose it with a `NEXT_PUBLIC_` prefix.

Vercel preview URLs are unique and Perminister app origins match exactly. Use a stable preview alias
and a separate app client if preview deployments need sign-in. The production app origin should use
the Vercel production URL (or a domain attached to the Vercel project), not the VPS API hostname.

## Current connection state

The dashboard uses authenticated Next.js Route Handlers as a server-side bridge to the VPS API. The
browser never receives the VPS bearer token or connects to Postgres. Each operation checks the
current Perminister session and authorizes the workspace action before forwarding the request. The
workspace viewer action is `<product-id>:workspace:read`; create, delete, role, and backup actions
require `<product-id>:members:manage` (workspace admin). A first workspace admin can initialize
their own grant through the setup control shown after signing in; Perminister still requires that
account to be an organization owner or admin.

The server-side controls can list and create databases, prevent deletion while a database has active
connections, create read-only or read-write login roles, create and download backups, and review an
operation log. A systemd timer creates daily custom-format `pg_dump` files and keeps 14 days on the
VPS. See [`vps-api/README.md`](vps-api/README.md) for the API contract. These backups stay on the same
VPS disk until downloaded, so keep another copy for recovery from server or disk loss.

Vercel environment variables are server-only: `PERMINISTER_CLIENT_ID`,
`PERMINISTER_CLIENT_SECRET`, `PERMINISTER_PRODUCT_ID`, `PERMINISTER_ORGANIZATION_ID`,
`NANOGRES_WORKSPACE_ID`, `NANOGRES_API_URL`, and `NANOGRES_API_TOKEN`. The production origin must
match the Perminister app client origin exactly, with callback
`<origin>/auth/perminister/callback`.

## Guardrails

```sh
pnpm health:audit
pnpm health
pnpm typecheck
pnpm lint
pnpm format:check
```

RepNix is configured as the repository health entry point and runs in the GitHub Actions guardrail
workflow. `ui-preview-kit` provides the unauthenticated local screen preview; it is not an alternate
production login path.
