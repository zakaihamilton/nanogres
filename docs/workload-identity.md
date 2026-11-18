# Passwordless SSH workload identity

Nanogres lets server products connect with a verified workload identity instead of a database password. The first provider adapter is Vercel OIDC. SSH carries each PostgreSQL connection through a restricted tunnel; the grant model stays provider-neutral.

## Model

- An organization grants an OIDC identity an exact database and login role. A grant records a display name, issuer, audience, subject, database, and role. Issuer, audience, and subject must all match; wildcard subjects are not supported.
- A workload presents its short-lived OIDC token to Nanogres over HTTPS. Nanogres validates the signature from the issuer's published JWKS and checks issuer, audience, subject, expiry, and any configured environment claims.
- Nanogres returns a 15-minute SSH public-key grant tied to the approved database role, plus a short-lived PostgreSQL client certificate. The workload generates the SSH keypair locally; its private key stays in memory and only its public key reaches Nanogres.
- A dedicated OpenSSH service accepts only ephemeral workload keys. Each key is restricted to local PostgreSQL forwarding on the one PgBouncer listener selected for its role; shell, remote forwarding, agent forwarding, X11, and TTY access are disabled. The SSH stream is carried over WebSocket at a dedicated path on the existing HTTPS endpoint, so the VPS firewall needs no new SSH port.
- PgBouncer's workload listeners bind only to loopback and accept short-lived client certificates. Its private auth query still checks the PostgreSQL role's SCRAM verifier, so existing database roles and PostgreSQL privileges remain in force. No PostgreSQL listener is exposed for workload connections.
- SSH host keys are checked against the fingerprint returned over Nanogres HTTPS. PostgreSQL TLS continues to verify the `nanogres.duckdns.org` server certificate inside the SSH tunnel.
- Runtime certificates use transaction pooling. Migration certificates use session pooling so `SET ROLE` and advisory locks keep their session semantics.

## Control plane

The Nanogres Access & roles page manages grants within the selected organization. The control API stores grants in a root-owned, organization-scoped state file, validates the database and role at grant creation, and supports revocation. A certificate request must identify one stored grant; the certificate issuer never accepts arbitrary PostgreSQL usernames.

The public identity endpoint does not accept cookies or the Nanogres management token. A product sends its bearer OIDC token, requested organization/database/role, and a newly generated SSH public key. Nanogres checks the exact grant before asking the private VPS API to issue a PostgreSQL client certificate and register the expiring SSH key. The management token and SSH private key are never given to Nanogres.

## Vercel adapter

Enable Secure Backend Access with OIDC for each Vercel project. A Vercel function sends the platform token from `x-vercel-oidc-token`; local development obtains `VERCEL_OIDC_TOKEN` with `vercel env pull`. A grant normally pins:

- Issuer: `https://oidc.vercel.com/<team-slug>`
- Audience: `https://vercel.com/<team-slug>`
- Subject: `owner:<team-slug>:project:<project-name>:environment:<production|preview|development>`

Other OIDC providers use the same exact-match grant model. Provider-specific token retrieval remains an adapter at the product boundary; no product name or Vercel claim is hard-coded into Nanogres.

## Client behavior

The Node.js client creates an ephemeral SSH keypair, requests workload credentials on first use, and opens a loopback-only SSH tunnel to the matching Nanogres PgBouncer listener. `pg` connects through that tunnel with TLS certificate validation enabled. The client refreshes the pool shortly before the 15-minute SSH grant and client certificate expire, and keeps both private keys in process memory only. Runtime and migration identity names, database, and organization are non-secret configuration; no PostgreSQL password or Nanogres management token belongs in product environment variables.

The protocol must stay additive during rollout: existing password-based listeners remain available while the dedicated certificate listeners are introduced and validated. The passwordless path is enabled only after the VPS listeners and organization grants are ready.

## Rollout and recovery

1. Install the client CA, loopback-only PgBouncer listeners, a dedicated loopback-only SSH service, and the WebSocket bridge on the VPS. Keep the existing HTTPS firewall rule; do not expose SSH or workload PgBouncer ports.
2. Deploy the Nanogres grant management and OIDC exchange routes.
3. Enable Vercel OIDC and add narrowly-scoped grants for each product, environment, database, and role.
4. Migrate one product at a time, verify live queries and migrations, then remove that product's static database URLs.
5. Revoke a grant to prevent new SSH keys and certificates. Existing grants and certificates expire within 15 minutes; SSH sessions end when the owning client pool closes.

If an issuer is unavailable, certificate renewal fails closed. Existing established PostgreSQL sessions continue until they are closed; new sessions require a valid certificate.
