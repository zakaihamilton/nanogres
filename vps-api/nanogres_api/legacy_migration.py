"""Migration planning and execution for pre-tenant legacy databases, roles, and backups."""

from __future__ import annotations

import json
from pathlib import Path

from . import config as _config
from . import pg as _pg
from . import quotas_offsite as _quotas_offsite
from . import tenants as _tenants
from .config import (
    ApiError,
    BACKUP_PATTERN,
    TENANT_NAME_MAX_LENGTH,
    TENANT_NAME_PATTERN,
    TENANT_PREFIX_PATTERN,
)
from .pg import quote_identifier, quote_literal


def legacy_organization_migration_plan(organization_id: object) -> dict[str, object]:
    """Inspect un-prefixed databases, roles, backups, quotas, and logs for safe tenant migration."""
    org_id = _config.resolve("normalized_organization_id", _tenants.normalized_organization_id)(
        organization_id
    )
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(org_id)
    all_databases = _config.resolve("list_databases", _tenants.list_databases)()
    existing_databases = {
        str(row.get("name")) for row in all_databases if isinstance(row, dict)
    }
    databases: list[tuple[str, str]] = []
    for row in all_databases:
        old_name = row.get("name")
        if not isinstance(old_name, str) or row.get("systemDatabase"):
            continue
        if old_name.startswith(prefix):
            logical_name = old_name[len(prefix) :]
            if TENANT_NAME_PATTERN.fullmatch(logical_name):
                if int(row.get("connections", 0)) > 0:
                    raise ApiError(
                        409,
                        f"Organization database {logical_name!r} still has active connections. Stop clients and retry.",
                    )
                databases.append((old_name, old_name))
            continue
        if TENANT_PREFIX_PATTERN.match(old_name):
            continue
        if not TENANT_NAME_PATTERN.fullmatch(old_name):
            raise ApiError(
                400,
                f"Legacy database {old_name!r} is longer than the {TENANT_NAME_MAX_LENGTH}-character organization limit or has an unsupported name.",
            )
        if int(row.get("connections", 0)) > 0:
            raise ApiError(
                409,
                f"Legacy database {old_name!r} still has active connections. Stop clients and retry.",
            )
        new_name = prefix + old_name
        if len(new_name.encode("utf-8")) > 63 or (
            new_name in existing_databases and new_name != old_name
        ):
            raise ApiError(409, f"The organization-scoped name for {old_name!r} is unavailable.")
        databases.append((old_name, new_name))

    json_query = _config.resolve("json_query", _pg.json_query)
    role_rows = json_query(
        "SELECT COALESCE(json_agg(rolname ORDER BY rolname), '[]'::json)::text "
        "FROM pg_roles WHERE rolcanlogin AND rolname !~ '^pg_' "
        "AND rolname NOT IN ('postgres', 'nanogres_api')"
    )
    if not isinstance(role_rows, list):
        raise ApiError(503, "PostgreSQL returned invalid role metadata.")
    existing_roles = {
        str(row["name"])
        for row in json_query(
            "SELECT COALESCE(json_agg(json_build_object('name', rolname) ORDER BY rolname), '[]'::json)::text "
            "FROM pg_roles"
        )
        if isinstance(row, dict) and isinstance(row.get("name"), str)
    }
    roles: list[tuple[str, str]] = []
    for old_name in role_rows:
        if not isinstance(old_name, str) or TENANT_PREFIX_PATTERN.match(old_name):
            continue
        if not TENANT_NAME_PATTERN.fullmatch(old_name):
            raise ApiError(
                400,
                f"Legacy login role {old_name!r} is longer than the {TENANT_NAME_MAX_LENGTH}-character organization limit or has an unsupported name.",
            )
        new_name = prefix + old_name
        if len(new_name.encode("utf-8")) > 63 or (
            new_name in existing_roles and new_name != old_name
        ):
            raise ApiError(409, f"The organization-scoped name for role {old_name!r} is unavailable.")
        roles.append((old_name, new_name))

    backup_root = _config.cfg("BACKUP_DIR")
    backup_sources: list[Path] = []
    for directory in (backup_root, backup_root / "legacy"):
        if not directory.exists() or directory.is_symlink():
            continue
        for path in directory.iterdir():
            if (
                path.is_file()
                and not path.is_symlink()
                and BACKUP_PATTERN.fullmatch(path.name)
            ):
                backup_database = path.name.split("__", 1)[0]
                if not TENANT_NAME_PATTERN.fullmatch(backup_database):
                    raise ApiError(
                        400,
                        f"Legacy backup {path.name!r} cannot be moved because its database name exceeds the organization limit.",
                    )
                backup_sources.append(path)

    destination_dir = _config.resolve(
        "organization_backup_dir", _tenants.organization_backup_dir
    )(org_id)
    if destination_dir.exists() and destination_dir.is_symlink():
        raise ApiError(409, "The organization backup directory is not a regular directory.")
    for path in backup_sources:
        if (destination_dir / path.name).exists():
            raise ApiError(409, f"The organization backup {path.name!r} already exists.")

    old_policy = _config.resolve("read_quota_policy", _quotas_offsite.read_quota_policy)()
    policy: dict[str, int] = {}
    database_names = dict(databases)
    for name, max_bytes in old_policy.items():
        if TENANT_PREFIX_PATTERN.match(name):
            policy[name] = max_bytes
        elif not TENANT_NAME_PATTERN.fullmatch(name):
            raise ApiError(
                400,
                f"Legacy quota setting for {name!r} must be removed or shortened before migration.",
            )
        else:
            policy[database_names.get(name, prefix + name)] = max_bytes

    events_file = _config.cfg("EVENTS_FILE")
    if events_file.exists():
        try:
            for line in events_file.read_text(encoding="utf-8").splitlines():
                if line:
                    json.loads(line)
        except (OSError, json.JSONDecodeError) as error:
            raise ApiError(
                503, "The activity log is invalid and cannot be migrated safely."
            ) from error

    return {
        "organizationId": org_id,
        "prefix": prefix,
        "databases": databases,
        "roles": roles,
        "backups": backup_sources,
        "quotaPolicy": policy,
    }


def migrate_legacy_organization(organization_id: object) -> dict[str, int]:
    """Execute the validated migration plan to scope legacy resources under an organization."""
    plan = _config.resolve(
        "legacy_organization_migration_plan", legacy_organization_migration_plan
    )(organization_id)
    org_id = str(plan["organizationId"])
    prefix = str(plan["prefix"])
    role_name = _config.resolve("organization_query_role", _tenants.organization_query_role)(org_id)
    databases = plan["databases"]
    roles = plan["roles"]
    backups = plan["backups"]
    policy = plan["quotaPolicy"]
    assert isinstance(databases, list)
    assert isinstance(roles, list)
    assert isinstance(backups, list)
    assert isinstance(policy, dict)

    run_sql = _config.resolve("run_sql", _pg.run_sql)
    secure_db = _config.resolve("secure_organization_database", _tenants.secure_organization_database)
    transfer_objects = _config.resolve(
        "transfer_database_objects", _tenants.transfer_database_objects
    )

    role_exists = run_sql(
        f"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {quote_literal(role_name)})"
    )
    if role_exists != "t":
        run_sql(
            f"CREATE ROLE {quote_identifier(role_name)} WITH NOLOGIN NOSUPERUSER "
            "NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
        )

    for old_name, new_name in roles:
        run_sql(f"ALTER ROLE {quote_identifier(old_name)} RENAME TO {quote_identifier(new_name)}")

    for old_name, new_name in databases:
        if old_name != new_name:
            run_sql(
                f"ALTER DATABASE {quote_identifier(old_name)} RENAME TO {quote_identifier(new_name)}"
            )
        run_sql(
            f"ALTER DATABASE {quote_identifier(new_name)} OWNER TO {quote_identifier(role_name)}"
        )
        secure_db(new_name, role_name)
        transfer_objects(new_name, role_name)

    destination_dir = _config.resolve(
        "organization_backup_dir", _tenants.organization_backup_dir
    )(org_id)
    destination_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    for source in backups:
        source.replace(destination_dir / source.name)
    legacy_dir = _config.cfg("BACKUP_DIR") / "legacy"
    if legacy_dir.exists() and not any(legacy_dir.iterdir()):
        legacy_dir.rmdir()

    _config.resolve("write_quota_policy", _quotas_offsite.write_quota_policy)(policy)
    try:
        _config.cfg("QUOTA_REQUEST_FILE").touch(mode=0o600, exist_ok=True)
    except OSError:
        pass

    events_file = _config.cfg("EVENTS_FILE")
    if events_file.exists():
        events = [
            json.loads(line)
            for line in events_file.read_text(encoding="utf-8").splitlines()
            if line
        ]
        migrated = [
            {**event, "organizationId": org_id, "organizationPrefix": prefix}
            if isinstance(event, dict)
            and not event.get("organizationId")
            and not event.get("organizationPrefix")
            else event
            for event in events
        ]
        content = "".join(json.dumps(event, separators=(",", ":")) + "\n" for event in migrated)
        _config.atomic_write_text(
            events_file,
            content,
            prefix=".events.",
            fsync=True,
        )

    return {
        "databases": len(databases),
        "roles": len(roles),
        "backups": len(backups),
    }
