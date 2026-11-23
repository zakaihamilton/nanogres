"""Organization tenant scoping, roles, database lifecycle, and activity logs."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from . import config as _config
from . import pg as _pg
from .config import (
    ACTOR_PATTERN,
    ApiError,
    NAME_PATTERN,
    ORGANIZATION_PATTERN,
    TENANT_NAME_MAX_LENGTH,
    TENANT_NAME_PATTERN,
    TENANT_PREFIX_PATTERN,
    TRANSFER_INTERNAL_PATTERN,
    event_lock,
    query_role_lock,
    quota_policy_lock,
)
from .pg import quote_identifier, quote_literal


def valid_name(value: object, label: str) -> str:
    """Validate an unprefixed PostgreSQL identifier name."""
    if not isinstance(value, str) or not NAME_PATTERN.fullmatch(value):
        raise ApiError(
            400,
            f"{label} must start with a lowercase letter and contain only lowercase letters, numbers, or underscores.",
        )
    return value


def normalized_organization_id(value: object) -> str:
    """Validate and normalize an organization identifier."""
    if not isinstance(value, str) or not ORGANIZATION_PATTERN.fullmatch(value.strip()):
        raise ApiError(400, "A valid organization scope is required.")
    return value.strip().lower()


def organization_prefix(organization_id: object) -> str:
    """Return the deterministic 26-character physical prefix for an organization."""
    normalized = normalized_organization_id(organization_id)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
    return f"n{digest}_"


def organization_query_role(organization_id: object) -> str:
    """Return the internal query-owner role name for an organization."""
    return organization_prefix(organization_id) + "_nanogres_query"


def tenant_resource_name(organization_id: object, value: object, label: str) -> str:
    """Validate a logical tenant resource name and return its physical prefixed name."""
    if not isinstance(value, str) or not TENANT_NAME_PATTERN.fullmatch(value):
        raise ApiError(
            400,
            f"{label} must start with a lowercase letter and contain only lowercase letters, numbers, or underscores (up to {TENANT_NAME_MAX_LENGTH} characters).",
        )
    return organization_prefix(organization_id) + value


def tenant_resource_label(organization_id: object, physical_name: object) -> str | None:
    """Strip an organization's physical prefix from a resource name, or return None."""
    prefix = organization_prefix(organization_id)
    if not isinstance(physical_name, str) or not physical_name.startswith(prefix):
        return None
    return physical_name[len(prefix) :]


def organization_backup_dir(organization_id: object) -> Path:
    """Return the backup directory scoped to an organization."""
    return _config.cfg("BACKUP_DIR") / organization_prefix(organization_id).rstrip("_")


def organization_database_name(organization_id: object, logical_name: object) -> str:
    """Validate a logical database name and map it to its physical tenant name."""
    if not isinstance(logical_name, str) or logical_name in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Choose a user database in your organization.")
    return tenant_resource_name(organization_id, logical_name, "Database name")


def require_organization_database(organization_id: object, logical_name: object) -> str:
    """Verify that an organization's logical database exists and return its physical name."""
    physical_name = organization_database_name(organization_id, logical_name)
    exists = _config.resolve("run_sql", _pg.run_sql)(
        f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(physical_name)})"
    )
    if exists != "t":
        raise ApiError(404, "Database not found.")
    return physical_name


def _query_role_password(org_id: str, api_token: str) -> str:
    return hmac.new(
        api_token.encode("utf-8"),
        f"nanogres-query:{org_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def ensure_organization_query_role(organization_id: object) -> str:
    """Create or sync the internal PostgreSQL role used for an organization's queries."""
    org_id = normalized_organization_id(organization_id)
    role_name = organization_query_role(org_id)
    api_token = os.environ.get("NANOGRES_API_TOKEN", "")
    if len(api_token) < 32:
        raise ApiError(503, "Management API is not configured.")
    password = _query_role_password(org_id, api_token)
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    with query_role_lock:
        exists = run_sql(
            f"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {quote_literal(role_name)})"
        )
        flags = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
        if exists == "t":
            statement = (
                f"ALTER ROLE {quote_identifier(role_name)} WITH {flags} "
                f"PASSWORD {quote_literal(password)}"
            )
        else:
            statement = (
                f"CREATE ROLE {quote_identifier(role_name)} WITH {flags} "
                f"PASSWORD {quote_literal(password)}"
            )
        run_sql(statement)
    return role_name


def secure_organization_database(physical_name: str, role_name: str) -> None:
    """Restrict database and public schema privileges to the organization query role."""
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    run_sql(
        f"REVOKE CONNECT ON DATABASE {quote_identifier(physical_name)} FROM PUBLIC; "
        f"GRANT CONNECT ON DATABASE {quote_identifier(physical_name)} TO {quote_identifier(role_name)}"
    )
    run_sql(
        f"REVOKE CREATE ON SCHEMA public FROM PUBLIC; "
        f"GRANT USAGE, CREATE ON SCHEMA public TO {quote_identifier(role_name)}",
        database=physical_name,
    )


def prepare_organization_database(organization_id: object, physical_name: str) -> None:
    """Ensure the organization query role exists and owns access to `physical_name`."""
    role_name = _config.resolve("ensure_organization_query_role", ensure_organization_query_role)(
        organization_id
    )
    _config.resolve("secure_organization_database", secure_organization_database)(
        physical_name, role_name
    )


def transfer_database_objects(database: str, owner_role: str) -> None:
    """Assign ownership of restored/migrated schemas and relations to `owner_role`."""
    json_query = _config.resolve("json_query", _pg.json_query)
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    schemas = json_query(
        "SELECT COALESCE(json_agg(nspname ORDER BY nspname), '[]'::json)::text "
        "FROM pg_namespace WHERE nspname <> 'information_schema' "
        "AND nspname !~ '^pg_' "
        "AND NOT EXISTS (SELECT 1 FROM pg_extension e WHERE e.extnamespace = pg_namespace.oid)",
        database=database,
    )
    if not isinstance(schemas, list):
        raise ApiError(503, "PostgreSQL returned invalid schema metadata.")
    for schema in schemas:
        if not isinstance(schema, str):
            continue
        if schema == "public":
            run_sql(
                f"REVOKE CREATE ON SCHEMA public FROM PUBLIC; "
                f"GRANT USAGE, CREATE ON SCHEMA public TO {quote_identifier(owner_role)}",
                database=database,
            )
        else:
            run_sql(
                f"ALTER SCHEMA {quote_identifier(schema)} OWNER TO {quote_identifier(owner_role)}",
                database=database,
            )
        relations = json_query(
            "SELECT COALESCE(json_agg(json_build_object('name', c.relname, 'kind', c.relkind) "
            "ORDER BY c.relname), '[]'::json)::text "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            f"WHERE n.nspname = {quote_literal(schema)} "
            "AND c.relkind IN ('r', 'v', 'm', 'p', 'S', 'f') "
            "AND NOT EXISTS (SELECT 1 FROM pg_depend dep "
            "WHERE dep.classid = 'pg_class'::regclass AND dep.objid = c.oid AND dep.deptype = 'e')",
            database=database,
        )
        if not isinstance(relations, list):
            raise ApiError(503, "PostgreSQL returned invalid relation metadata.")
        for relation in relations:
            if not isinstance(relation, dict):
                continue
            relation_name = relation.get("name")
            kind = relation.get("kind")
            if not isinstance(relation_name, str):
                continue
            keyword = "SEQUENCE" if kind == "S" else "TABLE"
            run_sql(
                f"ALTER {keyword} {quote_identifier(schema)}.{quote_identifier(relation_name)} "
                f"OWNER TO {quote_identifier(owner_role)}",
                database=database,
            )


def organization_query_env(organization_id: object) -> dict[str, str]:
    """Build client environment credentials for running queries as the organization query role."""
    org_id = normalized_organization_id(organization_id)
    role_name = _config.resolve("ensure_organization_query_role", ensure_organization_query_role)(
        org_id
    )
    api_token = os.environ["NANOGRES_API_TOKEN"]
    password = _query_role_password(org_id, api_token)
    env = _config.resolve("pg_client_env", _pg.pg_client_env)("10")
    env.update(
        {"PGHOST": "127.0.0.1", "PGSSLMODE": "disable", "PGUSER": role_name, "PGPASSWORD": password}
    )
    return env


def public_tenant_databases(
    organization_id: object, databases: list[dict[str, object]]
) -> list[dict[str, object]]:
    """Filter and translate physical database records into organization-scoped view models."""
    prefix = organization_prefix(organization_id)
    query_role = organization_query_role(organization_id)
    result = []
    for database in databases:
        physical_name = database.get("name")
        if (
            not isinstance(physical_name, str)
            or not physical_name.startswith(prefix)
            or database.get("systemDatabase")
        ):
            continue
        if TRANSFER_INTERNAL_PATTERN.fullmatch(physical_name[len(prefix) :]):
            continue
        owner = database.get("owner")
        if owner == query_role:
            owner = "Nanogres"
        else:
            owner = tenant_resource_label(organization_id, owner) or owner
        result.append(
            {
                **database,
                "name": physical_name[len(prefix) :],
                "connectionName": physical_name,
                "owner": owner,
            }
        )
    return result


def list_databases() -> list[dict[str, object]]:
    """Query PostgreSQL for all connectable non-template databases."""
    rows = _config.resolve("json_query", _pg.json_query)(
        """
        SELECT COALESCE(json_agg(row_to_json(items) ORDER BY items.name), '[]'::json)::text
        FROM (
          SELECT d.oid AS "quotaId",
                 d.datname AS name,
                 pg_get_userbyid(d.datdba) AS owner,
                 pg_database_size(d.oid) AS "sizeBytes",
                 (SELECT count(*) FROM pg_stat_activity a WHERE a.datid = d.oid) AS connections,
                 current_setting('max_connections')::int AS "maxConnections",
                 pg_encoding_to_char(d.encoding) AS encoding,
                 d.datname = 'postgres' AS "systemDatabase"
          FROM pg_database d
          WHERE d.datallowconn AND NOT d.datistemplate
        ) items
        """
    )
    return rows if isinstance(rows, list) else []


def create_database(
    organization_id: object,
    body: dict[str, object],
    actor: str | None,
) -> dict[str, object]:
    """Provision a new organization-scoped PostgreSQL database and return its view model."""
    from . import quotas_offsite as _quotas_offsite

    logical_name = str(body.get("name", ""))
    name = _config.resolve("organization_database_name", organization_database_name)(
        organization_id, logical_name
    )
    query_role = _config.resolve("ensure_organization_query_role", ensure_organization_query_role)(
        organization_id
    )
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    clear_quota = _config.resolve(
        "clear_database_quota_setting", _quotas_offsite.clear_database_quota_setting
    )
    prepare_db = _config.resolve("prepare_organization_database", prepare_organization_database)
    reconcile = _config.resolve("request_quota_reconcile", _quotas_offsite.request_quota_reconcile)

    with quota_policy_lock:
        exists = run_sql(
            f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(name)})"
        )
        if exists == "t":
            raise ApiError(409, "A database with that name already exists.")
        clear_quota(name)
        run_sql(
            f"CREATE DATABASE {quote_identifier(name)} OWNER {quote_identifier(query_role)} "
            "ENCODING 'UTF8' TEMPLATE template0"
        )
        try:
            prepare_db(organization_id, name)
            reconcile(name)
        except ApiError:
            run_sql(f"DROP DATABASE {quote_identifier(name)}")
            raise

    _config.resolve("record_event", record_event)(
        "database.created", f"Database {logical_name} created.", actor, organization_id
    )
    status = _config.resolve("postgres_status", _pg.postgres_status)()
    databases = _config.resolve(
        "add_database_growth_targets", _quotas_offsite.add_database_growth_targets
    )(
        _config.resolve("list_databases", list_databases)(),
        int(status["disk"]["freeBytes"]),
    )
    scoped_databases = _config.resolve("public_tenant_databases", public_tenant_databases)(
        organization_id, databases
    )
    return next(row for row in scoped_databases if row["name"] == logical_name)


def delete_database(
    organization_id: object,
    logical_name: str,
    actor: str | None,
) -> dict[str, object]:
    """Drop an idle organization-scoped database and clear its custom quota."""
    from . import quotas_offsite as _quotas_offsite

    name = _config.resolve("require_organization_database", require_organization_database)(
        organization_id, logical_name
    )
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    clear_quota = _config.resolve(
        "clear_database_quota_setting", _quotas_offsite.clear_database_quota_setting
    )
    reconcile = _config.resolve("request_quota_reconcile", _quotas_offsite.request_quota_reconcile)

    with quota_policy_lock:
        exists = run_sql(
            f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(name)})"
        )
        if exists != "t":
            raise ApiError(404, "Database not found.")
        count = run_sql(
            f"SELECT count(*) FROM pg_stat_activity WHERE datname = {quote_literal(name)}"
        )
        if count != "0":
            raise ApiError(409, "Close active connections before deleting this database.")
        run_sql(f"DROP DATABASE {quote_identifier(name)}")
        clear_quota(name)
        reconcile()

    _config.resolve("record_event", record_event)(
        "database.deleted", f"Database {logical_name} deleted.", actor, organization_id
    )
    return {"deleted": True, "name": logical_name}


def list_roles(organization_id: object) -> list[dict[str, object]]:
    """List login roles belonging to an organization and their granted databases."""
    prefix = organization_prefix(organization_id)
    internal_role = organization_query_role(organization_id)
    rows = _config.resolve("json_query", _pg.json_query)(
        f"""
        SELECT COALESCE(json_agg(row_to_json(items) ORDER BY items.name), '[]'::json)::text
        FROM (
          SELECT r.rolname AS name,
                 r.rolsuper AS superuser,
                 r.rolcreatedb AS "canCreateDatabase",
                 r.rolcreaterole AS "canCreateRole",
                 r.rolvaliduntil AS "validUntil",
                 r.rolname = 'postgres' AS "systemRole",
                 EXISTS (
                   SELECT 1 FROM pg_auth_members m
                   WHERE m.member = r.oid
                     AND m.roleid = (
                       SELECT oid FROM pg_roles
                       WHERE rolname = {quote_literal(internal_role)}
                     )
                 ) AS "migrationRole",
                 (
                   SELECT COALESCE(
                     json_agg(substr(d.datname, {len(prefix) + 1}) ORDER BY d.datname),
                     '[]'::json
                   )
                   FROM pg_database d
                   WHERE left(d.datname, {len(prefix)}) = {quote_literal(prefix)}
                     AND has_database_privilege(r.rolname, d.oid, 'CONNECT')
                 ) AS databases
          FROM pg_roles r
          WHERE r.rolcanlogin AND r.rolname !~ '^pg_'
        ) items
        """
    )
    if not isinstance(rows, list):
        return []
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        physical_name = row.get("name")
        logical_name = tenant_resource_label(organization_id, physical_name)
        if logical_name is None or physical_name == internal_role:
            continue
        databases = row.get("databases")
        physical_databases = databases if isinstance(databases, list) else []
        logical_databases = [
            label
            for value in physical_databases
            if (label := tenant_resource_label(organization_id, value)) is not None
        ]
        result.append(
            {
                **row,
                "name": logical_name,
                "loginName": physical_name,
                "database": logical_databases[0] if logical_databases else None,
                "connectionDatabase": physical_databases[0] if physical_databases else None,
                "migrationRole": row.get("migrationRole") is True,
                "assumeRole": internal_role if row.get("migrationRole") is True else None,
                "databases": logical_databases,
            }
        )
    return result


def create_role(
    body: dict[str, object],
    actor: str | None,
    organization_id: object,
) -> dict[str, object]:
    """Create a scoped readwrite, readonly, or migration role for a tenant database."""
    logical_name = str(body.get("name", ""))
    name = tenant_resource_name(organization_id, logical_name, "Role name")
    logical_database = str(body.get("database", ""))
    database = _config.resolve("require_organization_database", require_organization_database)(
        organization_id, logical_database
    )
    password = body.get("password")
    workload_identity_only = body.get("useWorkloadIdentity") is True
    access = body.get("access")
    if workload_identity_only:
        password = secrets.token_urlsafe(48)
    elif (
        not isinstance(password, str)
        or not 16 <= len(password) <= 256
        or any(ord(character) < 32 or ord(character) == 127 for character in password)
    ):
        raise ApiError(400, "Password must contain 16 to 256 printable characters.")
    if access not in {"readwrite", "readonly", "migration"}:
        raise ApiError(400, "Choose readwrite, readonly, or migration access.")
    if logical_name in {"postgres", "nanogres_api", "nanogres_internal_query"}:
        raise ApiError(400, "That role name is reserved.")

    run_sql = _config.resolve("run_sql", _pg.run_sql)
    if (
        run_sql(
            f"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {quote_literal(name)})",
            database,
        )
        == "t"
    ):
        raise ApiError(409, "A role with that name already exists.")
    query_role = _config.resolve("ensure_organization_query_role", ensure_organization_query_role)(
        organization_id
    )
    is_migration_role = access == "migration"
    inheritance = "NOINHERIT" if is_migration_role else "INHERIT"
    statements = [
        "BEGIN",
        "SET LOCAL password_encryption = 'scram-sha-256'",
        (
            f"CREATE ROLE {quote_identifier(name)} LOGIN {inheritance} "
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS "
            f"PASSWORD {quote_literal(password)}"
        ),
        f"GRANT CONNECT ON DATABASE {quote_identifier(database)} TO {quote_identifier(name)}",
    ]
    if is_migration_role:
        statements.append(f"GRANT {quote_identifier(query_role)} TO {quote_identifier(name)}")
    else:
        table_privileges = (
            "SELECT, INSERT, UPDATE, DELETE" if access == "readwrite" else "SELECT"
        )
        statements.extend(
            [
                f"GRANT USAGE ON SCHEMA public TO {quote_identifier(name)}",
                f"GRANT {table_privileges} ON ALL TABLES IN SCHEMA public TO {quote_identifier(name)}",
                f"ALTER DEFAULT PRIVILEGES FOR ROLE {quote_identifier(query_role)} IN SCHEMA public GRANT {table_privileges} ON TABLES TO {quote_identifier(name)}",
            ]
        )
        if access == "readwrite":
            statements.extend(
                [
                    f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO {quote_identifier(name)}",
                    f"ALTER DEFAULT PRIVILEGES FOR ROLE {quote_identifier(query_role)} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {quote_identifier(name)}",
                ]
            )
    statements.append("COMMIT")
    run_sql("; ".join(statements), database)
    _config.resolve("record_event", record_event)(
        "role.created",
        f"Role {logical_name} created for {logical_database} ({access}).",
        actor,
        organization_id,
    )
    return {
        "role": {
            "name": logical_name,
            "loginName": name,
            "database": logical_database,
            "connectionDatabase": database,
            "access": access,
            "migrationRole": is_migration_role,
            "assumeRole": query_role if is_migration_role else None,
        }
    }


def list_activity(
    organization_id: object,
    limit: int = 50,
) -> list[dict[str, object]]:
    """Read the most recent audit log events scoped to an organization."""
    events_file = _config.cfg("EVENTS_FILE")
    if limit <= 0 or not events_file.exists():
        return []
    try:
        org_id = normalized_organization_id(organization_id)
        prefix = organization_prefix(org_id)
        matches: list[dict[str, object]] = []

        def append_if_scoped(line: bytes) -> None:
            if not line:
                return
            try:
                event = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return
            if isinstance(event, dict) and (
                str(event.get("organizationId", "")).lower() == org_id
                or event.get("organizationPrefix") == prefix
            ):
                matches.append(event)

        scan_limit = _config.cfg("ACTIVITY_SCAN_MAX_BYTES")
        with events_file.open("rb") as handle:
            position = handle.seek(0, os.SEEK_END)
            scan_start = max(0, position - scan_limit)
            carry = b""
            while position > scan_start and len(matches) < limit:
                chunk_size = min(64 * 1024, position - scan_start)
                position -= chunk_size
                handle.seek(position)
                lines = (handle.read(chunk_size) + carry).split(b"\n")
                carry = lines[0]
                for line in reversed(lines[1:]):
                    append_if_scoped(line)
                    if len(matches) >= limit:
                        break
            if scan_start == 0 and carry and len(matches) < limit:
                append_if_scoped(carry)
        return matches
    except OSError:
        return []


def record_event(
    action: str,
    detail: str,
    actor: str | None = None,
    organization_id: object | None = None,
    organization_prefix_value: str | None = None,
) -> None:
    """Append a structured audit log event to the JSONL event log."""
    _config.cfg("STATE_DIR").mkdir(parents=True, exist_ok=True)
    events_file = _config.cfg("EVENTS_FILE")
    events_file.parent.mkdir(parents=True, exist_ok=True)
    event = {
        "action": action,
        "detail": detail,
        "actor": actor if actor and ACTOR_PATTERN.fullmatch(actor) else None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    if organization_id is not None:
        event["organizationId"] = normalized_organization_id(organization_id)
        event["organizationPrefix"] = organization_prefix(organization_id)
    elif organization_prefix_value is not None:
        if not TENANT_PREFIX_PATTERN.fullmatch(organization_prefix_value):
            raise ApiError(400, "Invalid organization event scope.")
        event["organizationPrefix"] = organization_prefix_value
    with event_lock:
        with events_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        os.chmod(events_file, 0o600)
