#!/usr/bin/env python3
"""CLI entrypoint and compatibility shim for the modular `nanogres_api` package."""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGE_ROOT = str(Path(__file__).resolve().parent)
if _PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, _PACKAGE_ROOT)

import nanogres_api as _nanogres_api  # noqa: E402
from nanogres_api import *  # noqa: E402, F403

globals().update(_nanogres_api.compat_exports())
_nanogres_api.register_compat_namespace(globals())


def main() -> int:
    """Run maintenance CLI commands or start the private Nanogres HTTP API server."""
    if "--migrate-legacy-organization" in sys.argv:
        index = sys.argv.index("--migrate-legacy-organization")
        if index + 1 >= len(sys.argv) or sys.argv.count("--migrate-legacy-organization") != 1:
            raise ApiError(400, "Provide one organization ID for the legacy migration.")
        organization_id = normalized_organization_id(sys.argv[index + 1])
        plan = legacy_organization_migration_plan(organization_id)
        counts = {
            "databases": len(plan["databases"]),
            "roles": len(plan["roles"]),
            "backups": len(plan["backups"]),
        }
        if "--apply" not in sys.argv:
            print(
                "Legacy organization migration plan: "
                f"{counts['databases']} database(s), {counts['roles']} role(s), "
                f"{counts['backups']} backup(s). No changes made."
            )
            return 0
        counts = migrate_legacy_organization(organization_id)
        print(
            "Migrated legacy Nanogres data: "
            f"{counts['databases']} database(s), {counts['roles']} role(s), "
            f"{counts['backups']} backup(s)."
        )
        return 0
    if "--backup-all" in sys.argv:
        with backup_lock:
            print(f"Created {backup_all()} Nanogres backup(s).")
        return 0
    initialize_transfer_jobs()
    server = ThreadingHTTPServer((API_HOST, API_PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ApiError as error:
        print(error.message, file=sys.stderr)
        raise SystemExit(1)
