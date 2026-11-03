# VPS installation notes

Run `vps-api/install-vps.sh` as root after copying this directory onto the server. It installs the
loopback-only API, systemd backup timer, root-owned service config, and generates a random bearer
token in `/etc/nanogres/api.env`. It does not enable the Nginx proxy or open a firewall port.

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
