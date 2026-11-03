# VPS installation notes

Run `vps-api/install-vps.sh` as root after copying this directory onto the server. It installs the
loopback-only API, local and off-site backup units, quota reconciler, and generates a random bearer
token in `/etc/nanogres/api.env`. It installs Ubuntu's `rclone` and `quota` packages if missing. It
does not enable the Nginx proxy or open a firewall port.

Before enabling the public proxy:

1. Add a webroot location for `/.well-known/acme-challenge/` to the existing HTTP server on port 80.
   The webroot should be `/var/www/nanogres-acme` and the DuckDNS name must resolve to this server.
2. Issue a trusted certificate with `certbot certonly --webroot -w /var/www/nanogres-acme -d nanogres.duckdns.org`.
3. Install `nginx-nanogres.conf`, run `nginx -t`, then reload Nginx. It listens on 8443; port 443
   stays assigned to the existing TURN server. The 5 MiB request limit allows the dashboard's 4 MiB
   restore chunks through Nginx.
4. Open TCP 8443 in UFW and verify the API from outside. Postgres remains loopback-only.
5. Copy the token from `/etc/nanogres/api.env` into Vercel's encrypted production environment
   variable `NANOGRES_API_TOKEN`. Keep it out of source files and browser code.

The first two public network changes are deliberate access-control changes. Review the firewall and
Nginx diffs before applying them. The API token should be transferred only to the Nanogres Vercel
project.

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
