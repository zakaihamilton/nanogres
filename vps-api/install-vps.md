# VPS installation notes

Run `vps-api/install-vps.sh` as root after copying this directory onto the server. It installs the
loopback-only API, local and off-site backup units, quota reconciler, and PgBouncer. It generates a
random API bearer token in `/etc/nanogres/api.env` and a separate PgBouncer authentication secret
under `/etc/nanogres`. It installs Ubuntu/Debian's `rclone` and `quota` packages if missing, and
uses the official PostgreSQL APT repository to install a current PgBouncer release (1.26.1 or newer).
Rerunning it applies API and pooler updates. It does not enable the Nginx proxy or change firewall
rules.

## Enable the public endpoints

1. Add a webroot location for `/.well-known/acme-challenge/` to the existing HTTP server on port 80.
   The webroot should be `/var/www/nanogres-acme` and `nanogres.duckdns.org` must resolve to this server.
2. Issue a trusted certificate with
   `certbot certonly --webroot -w /var/www/nanogres-acme -d nanogres.duckdns.org`.
3. Rerun `vps-api/install-vps.sh`. It copies the certificate and private key into a restricted
   PgBouncer directory and enables two TLS listeners: port 6432 uses transaction pooling for app
   traffic; port 6433 uses session pooling for schema migrations. The installer disables Ubuntu's
   generic `pgbouncer.service` when the Nanogres listeners are activated. Certificate renewals copy
   the new files and reload both listeners.
4. Install `nginx-nanogres.conf`, run `nginx -t`, then reload Nginx. The API proxy listens on 8443;
   port 443 stays assigned to the existing TURN server. The 5 MiB request limit allows the dashboard's
   4 MiB restore chunks through Nginx.
5. Open inbound TCP 8443, 6432, and 6433 in the VPS and provider firewalls, then verify each service
   from outside. These are deliberate public access changes. PgBouncer requires TLS and SCRAM
   authentication; PostgreSQL itself must remain bound to `127.0.0.1:5432`. The installer does not
   open any ports automatically.
6. Copy the token from `/etc/nanogres/api.env` into Vercel's encrypted production environment
   variable `NANOGRES_API_TOKEN`. Keep it out of source files and browser code.

The connection modal defaults to `nanogres.duckdns.org`, runtime port 6432, migration port 6433, and
`sslmode=verify-full`. For a different public DNS name, set Nanogres' Vercel build-time variable
`NEXT_PUBLIC_NANOGRES_DB_HOST` before deploying. The optional
`NEXT_PUBLIC_NANOGRES_DB_PORT` and `NEXT_PUBLIC_NANOGRES_DB_MIGRATION_PORT` variables override the
two port defaults. These values are public connection settings and must not contain passwords.

For Visitoring, create a normal **Read and write** role for runtime access and a **Schema migration**
role for migrations. In Visitoring's Vercel environment, use the normal role's connection URI for
`DATABASE_URL`; use the migration role's session-pool URI for `MIGRATION_DATABASE_URL`; and copy
the owner role shown by the migration snippet into `MIGRATION_DATABASE_ROLE`. Visitoring then uses
the transaction pool for requests and the session pool while applying Drizzle migrations.

The API uses the local peer-auth socket for administrative operations and loopback TCP password
authentication for restricted organization SQL roles. Keep PostgreSQL listening on loopback and make
sure its `pg_hba.conf` permits `127.0.0.1/32` connections using `scram-sha-256` (Ubuntu's default
local TCP rule). Do not add a remote PostgreSQL listener or a `trust` authentication rule.

The public network changes are deliberate access-control changes. Review the firewall and Nginx
configuration before applying them. Transfer the API token only to the Nanogres Vercel project.

## Enable hard per-database limits on the root ext4 volume

The current `/dev/sda1` root filesystem has no ext4 `project` or `quota` features. The quota
reconciler stays in advisory mode until project quotas are enabled and verified. This maintenance
requires downtime and an offline filesystem check. Make sure a recent dump has completed and the
dashboard shows a successful upload to Spaces before proceeding.

1. In Cloudfanatic, boot the VPS into its rescue environment and open its root console or SSH into
   the rescue system. PostgreSQL will be unavailable during this maintenance.
2. Identify the root ext4 device with `lsblk -f`, then inspect the installed system's `/etc/fstab` to
   confirm its root UUID and options. Do not assume the device name if it differs from `/dev/sda1`.
3. Ensure the target root filesystem is unmounted. Run `e2fsck -f /dev/sda1` and stop if it reports
   errors that need review. Enable project tracking and project quota metadata:

   ```sh
   tune2fs -O project -Q prjquota /dev/sda1
   e2fsck -f /dev/sda1
   ```

4. Mount the installed system at `/mnt`. In `/mnt/etc/fstab`, add `prjquota` to the options for the
   root filesystem without changing its UUID or other options. Confirm the ext4 feature list with
   `tune2fs -l /dev/sda1` includes `project` and `quota`, then unmount `/mnt` and reboot normally.
5. After boot, verify `findmnt -no FSTYPE,OPTIONS /` includes `ext4` and `prjquota`, and that
   `repquota -P -v /` succeeds. The five-minute reconciler will assign existing databases and apply
   their limits; the dashboard changes from “Advisory target” only after those limits are verified.

If `e2fsck` requests interactive repair, the filesystem features are unsupported, or the normal
boot fails, stop and use the provider rescue environment to restore the previous boot state. Do not
force a mount or continue with quota enforcement disabled. See `vps-api/README.md` for quota scope,
growth formula, and Spaces setup.
