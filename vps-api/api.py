#!/usr/bin/env python3
"""Small, private HTTP control API for the Nanogres Postgres host."""

from __future__ import annotations

import csv
import hashlib
import hmac
import ipaddress
import io
import json
import os
import re
import selectors
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


API_HOST = os.environ.get("NANOGRES_API_HOST", "127.0.0.1")
API_PORT = int(os.environ.get("NANOGRES_API_PORT", "8765"))
PG_BIN_DIR = Path(os.environ.get("NANOGRES_PG_BIN_DIR", "/usr/bin"))
BACKUP_DIR = Path(os.environ.get("NANOGRES_BACKUP_DIR", "/var/backups/nanogres"))
STATE_DIR = Path(os.environ.get("NANOGRES_STATE_DIR", "/var/lib/nanogres"))
EVENTS_FILE = STATE_DIR / "events.jsonl"
BACKUP_RETENTION_DAYS = int(os.environ.get("NANOGRES_BACKUP_RETENTION_DAYS", "14"))
DATABASE_GROWTH_PERCENT = int(os.environ.get("NANOGRES_DATABASE_GROWTH_PERCENT", "25"))
DATABASE_QUOTA_RESERVE_BYTES = int(
    os.environ.get("NANOGRES_DATABASE_QUOTA_RESERVE_BYTES", str(1024**3))
)
if DATABASE_QUOTA_RESERVE_BYTES < 0:
    DATABASE_QUOTA_RESERVE_BYTES = 1024**3
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
ORGANIZATION_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
TENANT_PREFIX_PATTERN = re.compile(r"^n[0-9a-f]{24}_")
TENANT_NAME_MAX_LENGTH = 37
TENANT_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,36}$")
BACKUP_PATTERN = re.compile(r"^([a-z][a-z0-9_]*)__([0-9]{8}T[0-9]{12}Z)\.dump$")
UPLOAD_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
ACTOR_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
RESTORE_UPLOAD_TTL = timedelta(hours=24)
RESTORE_UPLOAD_DIR = STATE_DIR / "restore-uploads"
TRANSFER_DIR = STATE_DIR / "transfers"
TRANSFER_JOB_PATTERN = re.compile(r"^[a-f0-9]{32}$")
TRANSFER_INTERNAL_PATTERN = re.compile(r"^transfer_(?:old_)?[a-f0-9]{24}$")
TRANSFER_MAX_ACTIVE = 2
TRANSFER_TIMEOUT_SECONDS = 24 * 60 * 60
RESTORE_UPLOAD_DISK_RESERVE_BYTES = 512 * 1024 * 1024
QUOTA_STATUS_FILE = STATE_DIR / "database-quotas.json"
QUOTA_POLICY_FILE = STATE_DIR / "database-quota-policy.json"
OFFSITE_STATUS_FILE = STATE_DIR / "offsite-backup-status.json"
OFFSITE_ENV_FILE = Path("/etc/nanogres/backup.env")
OFFSITE_BACKUP_MAX_AGE = timedelta(hours=36)
QUOTA_REQUEST_FILE = STATE_DIR / "quota-reconcile.request"
OFFSITE_REQUEST_FILE = STATE_DIR / "offsite-backup.request"
# Activity is polled repeatedly; cap each scan even when another organization is much busier.
ACTIVITY_SCAN_MAX_BYTES = 1024 * 1024
event_lock = threading.Lock()
backup_lock = threading.Lock()
quota_policy_lock = threading.Lock()
query_role_lock = threading.Lock()
transfer_lock = threading.RLock()
transfer_jobs: dict[str, dict[str, object]] = {}
transfer_workers: dict[str, threading.Thread] = {}
transfer_processes: dict[str, subprocess.Popen[str]] = {}
transfer_cancel_events: dict[str, threading.Event] = {}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def pg_client(binary: str) -> str:
    return str(PG_BIN_DIR / binary)


def pg_client_env(timeout: str = "5") -> dict[str, str]:
    env = {
        "PATH": f"{PG_BIN_DIR}:/usr/bin:/bin",
        "LC_ALL": "C",
        "PGCONNECT_TIMEOUT": timeout,
    }
    for key in ("PGHOST", "PGPORT", "PGUSER", "PGSSLMODE"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def normalized_organization_id(value: object) -> str:
    if not isinstance(value, str) or not ORGANIZATION_PATTERN.fullmatch(value.strip()):
        raise ApiError(400, "A valid organization scope is required.")
    return value.strip().lower()


def organization_prefix(organization_id: object) -> str:
    normalized = normalized_organization_id(organization_id)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
    return f"n{digest}_"


def organization_query_role(organization_id: object) -> str:
    return organization_prefix(organization_id) + "_nanogres_query"


def tenant_resource_name(organization_id: object, value: object, label: str) -> str:
    if not isinstance(value, str) or not TENANT_NAME_PATTERN.fullmatch(value):
        raise ApiError(
            400,
            f"{label} must start with a lowercase letter and contain only lowercase letters, numbers, or underscores (up to {TENANT_NAME_MAX_LENGTH} characters).",
        )
    return organization_prefix(organization_id) + value


def tenant_resource_label(organization_id: object, physical_name: object) -> str | None:
    prefix = organization_prefix(organization_id)
    if not isinstance(physical_name, str) or not physical_name.startswith(prefix):
        return None
    return physical_name[len(prefix):]


def organization_backup_dir(organization_id: object) -> Path:
    return BACKUP_DIR / organization_prefix(organization_id).rstrip("_")


def organization_database_name(organization_id: object, logical_name: object) -> str:
    if not isinstance(logical_name, str) or logical_name in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Choose a user database in your organization.")
    return tenant_resource_name(organization_id, logical_name, "Database name")


def require_organization_database(organization_id: object, logical_name: object) -> str:
    physical_name = organization_database_name(organization_id, logical_name)
    exists = run_sql(
        f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(physical_name)})"
    )
    if exists != "t":
        raise ApiError(404, "Database not found.")
    return physical_name


def ensure_organization_query_role(organization_id: object) -> str:
    org_id = normalized_organization_id(organization_id)
    role_name = organization_query_role(org_id)
    api_token = os.environ.get("NANOGRES_API_TOKEN", "")
    if len(api_token) < 32:
        raise ApiError(503, "Management API is not configured.")
    password = hmac.new(
        api_token.encode("utf-8"),
        f"nanogres-query:{org_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
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
    role_name = ensure_organization_query_role(organization_id)
    secure_organization_database(physical_name, role_name)


def transfer_database_objects(database: str, owner_role: str) -> None:
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


def _transfer_metadata_path(transfer_id: str) -> Path:
    if not TRANSFER_JOB_PATTERN.fullmatch(transfer_id):
        raise ApiError(404, "Transfer not found.")
    return TRANSFER_DIR / f"{transfer_id}.json"


def _write_transfer_metadata(job: dict[str, object]) -> None:
    TRANSFER_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = _transfer_metadata_path(str(job["transferId"]))
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=TRANSFER_DIR)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(job, handle, separators=(",", ":"))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _public_transfer_job(job: dict[str, object]) -> dict[str, object]:
    result = {
        key: job.get(key)
        for key in (
            "transferId", "direction", "status", "phase", "message", "sourceDatabase",
            "targetDatabase", "createdAt", "updatedAt", "completedAt", "recoveryBackupRetained",
        )
    }
    result["canCancel"] = (
        job.get("status") in {"queued", "running"}
        and job.get("swapStarted") is not True
        and not str(job.get("phase", "")).startswith("recovering")
        and job.get("phase") != "restoring_external_rollback_copy"
    )
    return result


def _load_transfer_job(transfer_id: str, organization_id: object) -> dict[str, object]:
    path = _transfer_metadata_path(transfer_id)
    try:
        job = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(404, "Transfer not found.") from error
    if not isinstance(job, dict) or job.get("organizationPrefix") != organization_prefix(organization_id):
        raise ApiError(404, "Transfer not found.")
    return job


def list_transfer_jobs(organization_id: object) -> list[dict[str, object]]:
    TRANSFER_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    prefix = organization_prefix(organization_id)
    jobs = []
    for path in TRANSFER_DIR.glob("[0-9a-f]" * 32 + ".json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and value.get("organizationPrefix") == prefix:
            jobs.append(_public_transfer_job(value))
    return sorted(jobs, key=lambda value: str(value.get("createdAt", "")), reverse=True)[:20]


def _update_transfer_job(transfer_id: str, **changes: object) -> dict[str, object]:
    with transfer_lock:
        job = transfer_jobs.get(transfer_id)
        if job is None:
            try:
                job = json.loads(_transfer_metadata_path(transfer_id).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ApiError(404, "Transfer not found.") from error
        job.update(changes)
        job["updatedAt"] = datetime.now(timezone.utc).isoformat()
        transfer_jobs[transfer_id] = job
        _write_transfer_metadata(job)
        return job


def _resolved_public_address(host: str, port: int) -> str:
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as error:
        raise ApiError(400, "The database host could not be resolved.") from error
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if ip.is_global:
            return str(ip)
    raise ApiError(400, "The database host must resolve to a public internet address.")


def _quote_conninfo(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _passfile_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("\n", "\\n")


def _external_connection(raw: object, work_dir: Path) -> tuple[str, dict[str, str]]:
    if not isinstance(raw, str) or len(raw) > 4096:
        raise ApiError(400, "Enter a valid PostgreSQL connection string.")
    try:
        parsed = urlsplit(raw)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
            raise ValueError("invalid URL")
        host = parsed.hostname.rstrip(".").lower()
        if not host or host in {"localhost", "localhost.localdomain"}:
            raise ValueError("invalid host")
        port = parsed.port or 5432
        if not 1 <= port <= 65535:
            raise ValueError("invalid port")
        database = unquote(parsed.path.removeprefix("/"))
        username = unquote(parsed.username or "")
        password = unquote(parsed.password or "")
        query = parse_qs(parsed.query, keep_blank_values=True)
        if any(key not in {"sslmode", "channel_binding"} for key in query):
            raise ValueError("unsupported connection option")
        if any(len(values) != 1 for values in query.values()):
            raise ValueError("duplicate connection option")
        channel_binding = query.get("channel_binding", ["prefer"])[0]
        if channel_binding not in {"disable", "prefer", "require"}:
            raise ValueError("invalid channel binding")
        if not database or not username or not password or parsed.fragment:
            raise ValueError("incomplete URL")
        if any(ord(character) < 32 or ord(character) == 127 for value in (host, database, username, password) for character in value):
            raise ValueError("control character in connection detail")
    except (ValueError, UnicodeError) as error:
        raise ApiError(400, "Enter a PostgreSQL URL with a database, username, and password.") from error

    address = _resolved_public_address(host, port)
    conninfo = " ".join(
        f"{key}={_quote_conninfo(value)}"
        for key, value in (
            ("host", host), ("hostaddr", address), ("port", str(port)),
            ("dbname", database), ("user", username), ("sslmode", "verify-full"),
            ("channel_binding", channel_binding),
        )
    )
    passfile = work_dir / "pgpass"
    passfile.write_text(
        ":".join(_passfile_escape(value) for value in (host, str(port), database, username, password)) + "\n",
        encoding="utf-8",
    )
    os.chmod(passfile, 0o600)
    env = pg_client_env("10")
    env.update({"PGPASSFILE": str(passfile), "PGSSLMODE": "verify-full"})
    return conninfo, env


def _transfer_command(
    transfer_id: str,
    phase: str,
    command: list[str],
    env: dict[str, str],
    *,
    capture_stdout: bool = False,
    bypass_cancel: bool = False,
) -> str:
    if transfer_cancel_events[transfer_id].is_set() and not bypass_cancel:
        raise ApiError(409, "Transfer was cancelled.")
    _update_transfer_job(transfer_id, phase=phase, message=phase.replace("_", " ").capitalize())
    with transfer_lock:
        # Serialize process startup with cancel_transfer_job: otherwise a cancel
        # can set the event after the check above but before this process is
        # visible in transfer_processes, leaving it running until it exits.
        if transfer_cancel_events[transfer_id].is_set() and not bypass_cancel:
            raise ApiError(409, "Transfer was cancelled.")
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        transfer_processes[transfer_id] = process
    try:
        stdout, stderr = process.communicate(timeout=TRANSFER_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
        raise ApiError(504, "The database transfer exceeded its time limit.")
    finally:
        with transfer_lock:
            transfer_processes.pop(transfer_id, None)
    if transfer_cancel_events[transfer_id].is_set() and not bypass_cancel:
        raise ApiError(409, "Transfer was cancelled.")
    if process.returncode:
        # Never expose client stderr: some libpq errors echo connection details.
        detail = (stderr or "").lower()
        if "server version" in detail or "newer than" in detail:
            raise ApiError(400, "The VPS PostgreSQL tools do not support that database version.")
        if any(
            marker in detail
            for marker in (
                "authentication failed", "could not translate host", "connection timed out",
                "connection refused", "ssl error", "certificate verify failed", "no pg_hba.conf entry",
            )
        ):
            raise ApiError(400, "Could not connect to the PostgreSQL database. Check credentials, TLS, and provider network access.")
        raise ApiError(503, "PostgreSQL could not complete the transfer step.")
    return stdout or ""


def _external_sql(transfer_id: str, conninfo: str, env: dict[str, str], statement: str) -> str:
    return _transfer_command(
        transfer_id,
        "checking_external_database",
        [pg_client("psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "--dbname", conninfo, "-c", statement],
        env,
        capture_stdout=True,
    ).strip()


def _new_staging_database(organization_id: object, staging_name: str, owner: str) -> None:
    clear_database_quota_setting(staging_name)
    run_sql(
        f"CREATE DATABASE {quote_identifier(staging_name)} OWNER {quote_identifier(owner)} "
        "ENCODING 'UTF8' TEMPLATE template0"
    )
    try:
        prepare_organization_database(organization_id, staging_name)
    except ApiError:
        run_sql(f"DROP DATABASE {quote_identifier(staging_name)}")
        raise


def _replace_nanogres_database(
    organization_id: object,
    staging_name: str,
    logical_target: str,
    mode: str,
    transfer_id: str,
) -> None:
    target_name = organization_database_name(organization_id, logical_target)
    backup_name = organization_prefix(organization_id) + "transfer_old_" + transfer_id[:24]
    with backup_lock:
        with quota_policy_lock:
            target_exists = run_sql(
                f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(target_name)})"
            ) == "t"
            if mode == "new" and target_exists:
                raise ApiError(409, "A database with that name already exists.")
            if mode == "replace" and not target_exists:
                raise ApiError(404, "The database selected for replacement no longer exists.")
            with transfer_lock:
                if transfer_cancel_events[transfer_id].is_set():
                    raise ApiError(409, "Transfer was cancelled.")
                _update_transfer_job(
                    transfer_id,
                    swapStarted=True,
                    phase="finalizing_database",
                    message="Switching Nanogres database",
                )
            if target_exists:
                run_sql(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    f"WHERE datname = {quote_literal(target_name)} AND pid <> pg_backend_pid()"
                )
                run_sql(f"ALTER DATABASE {quote_identifier(target_name)} RENAME TO {quote_identifier(backup_name)}")
                _update_transfer_job(transfer_id, oldDatabaseRenamed=True)
            _update_transfer_job(transfer_id, swapAttempted=True)
            try:
                run_sql(f"ALTER DATABASE {quote_identifier(staging_name)} RENAME TO {quote_identifier(target_name)}")
            except (ApiError, OSError, subprocess.SubprocessError):
                if target_exists:
                    run_sql(f"ALTER DATABASE {quote_identifier(backup_name)} RENAME TO {quote_identifier(target_name)}")
                run_sql(f"DROP DATABASE {quote_identifier(staging_name)}")
                raise
            _update_transfer_job(transfer_id, newDatabaseRenamed=True)
            if target_exists:
                run_sql(f"DROP DATABASE {quote_identifier(backup_name)}")
            try:
                request_quota_reconcile(target_name)
            except ApiError:
                # The periodic reconciler will pick up the renamed database.
                pass


def _external_database_reset_sql() -> str:
    return """
DO $nanogres$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT nspname FROM pg_namespace
    WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
  LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', item.nspname);
  END LOOP;
  FOR item IN SELECT pubname FROM pg_publication LOOP
    EXECUTE format('DROP PUBLICATION %I', item.pubname);
  END LOOP;
END
$nanogres$;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO PUBLIC;
"""


def _restore_external_archive(
    transfer_id: str,
    conninfo: str,
    env: dict[str, str],
    archive: Path,
    work_dir: Path,
    *,
    phase: str,
    clear_first: bool,
    include_acls: bool,
    bypass_cancel: bool = False,
) -> None:
    script_path = work_dir / f"{phase}.sql"
    restore_command = [pg_client("pg_restore"), "--exit-on-error", "--no-owner"]
    if not include_acls:
        restore_command.append("--no-acl")
    restore_command.extend(["--file", str(script_path), str(archive)])
    _transfer_command(
        transfer_id,
        "preparing_external_restore",
        restore_command,
        env,
        bypass_cancel=bypass_cancel,
    )
    if clear_first:
        content = script_path.read_text(encoding="utf-8")
        script_path.write_text(_external_database_reset_sql() + "\n" + content, encoding="utf-8")
    _transfer_command(
        transfer_id,
        phase,
        [
            pg_client("psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction",
            "--file", str(script_path), "--dbname", conninfo,
        ],
        env,
        bypass_cancel=bypass_cancel,
    )


def _export_transfer(transfer_id: str, job: dict[str, object], raw_connection: str, work_dir: Path) -> None:
    organization_id = str(job["organizationId"])
    source_database = str(job["sourceDatabase"])
    source_name = require_organization_database(organization_id, source_database)
    conninfo, env = _external_connection(raw_connection, work_dir)
    target_mode = str(job["targetMode"])
    target_dump = work_dir / "nanogres.dump"
    rollback_dump = work_dir / "external-before.dump"
    _transfer_command(
        transfer_id,
        "dumping_nanogres_database",
        [pg_client("pg_dump"), "--format=custom", "--no-owner", "--no-acl", "--file", str(target_dump), "--dbname", source_name],
        pg_client_env("10"),
    )
    if target_mode == "empty":
        has_user_objects = _external_sql(
            transfer_id,
            conninfo,
            env,
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname <> 'public' "
            "AND nspname <> 'information_schema' AND nspname !~ '^pg_') OR "
            "EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f','c')) OR "
            "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
            "WHERE n.nspname='public') OR "
            "EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace "
            "WHERE n.nspname='public') OR "
            "EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') OR "
            "EXISTS (SELECT 1 FROM pg_largeobject_metadata) OR "
            "EXISTS (SELECT 1 FROM pg_publication)"
        )
        if has_user_objects == "t":
            raise ApiError(409, "The external database is not empty. Choose replace only if you intend to overwrite it.")
    else:
        _transfer_command(
            transfer_id,
            "saving_external_rollback_copy",
            [pg_client("pg_dump"), "--format=custom", "--no-owner", "--file", str(rollback_dump), "--dbname", conninfo],
            env,
        )

    try:
        if target_mode == "replace":
            _restore_external_archive(
                transfer_id,
                conninfo,
                env,
                target_dump,
                work_dir,
                phase="restoring_external_database",
                clear_first=True,
                include_acls=False,
            )
        else:
            _transfer_command(
                transfer_id,
                "restoring_external_database",
                [pg_client("pg_restore"), "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--dbname", conninfo, str(target_dump)],
                env,
            )
    except (ApiError, OSError, subprocess.SubprocessError) as transfer_error:
        if target_mode == "replace" and rollback_dump.exists():
            try:
                _restore_external_archive(
                    transfer_id,
                    conninfo,
                    env,
                    rollback_dump,
                    work_dir,
                    phase="restoring_external_rollback_copy",
                    clear_first=True,
                    include_acls=True,
                    bypass_cancel=True,
                )
            except (ApiError, OSError, subprocess.SubprocessError) as rollback_error:
                job["recoveryBackupRetained"] = True
                _update_transfer_job(transfer_id, recoveryBackupRetained=True)
                raise ApiError(503, "Transfer failed and the previous external database could not be restored. A recovery copy remains on the VPS.") from rollback_error
        raise transfer_error
    record_event("database.exported", f"Exported {source_database} to an external PostgreSQL database.", str(job.get("actor")), organization_id)


def _import_transfer(transfer_id: str, job: dict[str, object], raw_connection: str, work_dir: Path) -> None:
    organization_id = str(job["organizationId"])
    logical_target = str(job["targetDatabase"])
    mode = str(job["targetMode"])
    prefix = organization_prefix(organization_id)
    staging_name = prefix + "transfer_" + transfer_id[:24]
    owner = ensure_organization_query_role(organization_id)
    dump_file = work_dir / "external.dump"
    conninfo, env = _external_connection(raw_connection, work_dir)
    try:
        _transfer_command(
            transfer_id,
            "dumping_external_database",
            [pg_client("pg_dump"), "--format=custom", "--no-owner", "--no-acl", "--file", str(dump_file), "--dbname", conninfo],
            env,
        )
        _new_staging_database(organization_id, staging_name, owner)
        _transfer_command(
            transfer_id,
            "restoring_nanogres_database",
            [pg_client("pg_restore"), "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--dbname", staging_name, str(dump_file)],
            organization_query_env(organization_id),
        )
        transfer_database_objects(staging_name, owner)
        if transfer_cancel_events[transfer_id].is_set():
            raise ApiError(409, "Transfer was cancelled.")
        _replace_nanogres_database(organization_id, staging_name, logical_target, mode, transfer_id)
    except (ApiError, OSError, subprocess.SubprocessError):
        exists = run_sql(
            f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(staging_name)})"
        ) == "t"
        if exists:
            run_sql(f"DROP DATABASE {quote_identifier(staging_name)}")
        raise
    record_event(
        "database.imported" if mode == "new" else "database.imported_replaced",
        f"Imported an external PostgreSQL database as {logical_target}.",
        str(job.get("actor")),
        organization_id,
    )


def _run_transfer_job(transfer_id: str, raw_connection: str) -> None:
    work_dir = TRANSFER_DIR / transfer_id
    job = transfer_jobs[transfer_id]
    try:
        work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(work_dir, 0o700)
        _update_transfer_job(transfer_id, status="running", phase="starting", message="Starting transfer")
        if job["direction"] == "import":
            _import_transfer(transfer_id, job, raw_connection, work_dir)
        else:
            _export_transfer(transfer_id, job, raw_connection, work_dir)
        _update_transfer_job(
            transfer_id,
            status="succeeded",
            phase="complete",
            message="Transfer completed",
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    except ApiError as error:
        status = "cancelled" if error.status == 409 and transfer_cancel_events[transfer_id].is_set() else "failed"
        _update_transfer_job(
            transfer_id,
            status=status,
            phase=status,
            message=error.message,
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    except (OSError, subprocess.SubprocessError):
        _update_transfer_job(
            transfer_id,
            status="failed",
            phase="failed",
            message="The transfer could not complete because of a VPS or PostgreSQL error.",
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    except Exception:
        _update_transfer_job(
            transfer_id,
            status="failed",
            phase="failed",
            message="The transfer could not complete because of an unexpected VPS error.",
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    finally:
        try:
            if transfer_jobs[transfer_id].get("recoveryBackupRetained"):
                retained = work_dir / "external-before.dump"
                if retained.is_file():
                    destination = TRANSFER_DIR / f"{transfer_id}.recovery.dump"
                    try:
                        os.chmod(retained, 0o600)
                        os.replace(retained, destination)
                    except OSError:
                        transfer_jobs[transfer_id]["recoveryBackupRetained"] = False
                        try:
                            _update_transfer_job(
                                transfer_id,
                                recoveryBackupRetained=False,
                                message="Transfer and automatic recovery failed. The recovery copy could not be retained; check the external database.",
                            )
                        except (ApiError, OSError):
                            pass
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
            with transfer_lock:
                transfer_processes.pop(transfer_id, None)
                transfer_cancel_events.pop(transfer_id, None)
                transfer_workers.pop(transfer_id, None)


def create_transfer_job(body: dict[str, object], organization_id: object, actor: str | None) -> dict[str, object]:
    direction = body.get("direction")
    mode = body.get("targetMode")
    raw_connection = body.get("connectionString")
    if not isinstance(direction, str) or direction not in {"import", "export"}:
        raise ApiError(400, "Choose import or export.")
    if not isinstance(mode, str):
        raise ApiError(400, "Choose a supported transfer destination mode.")
    allowed_modes = {"new", "replace"} if direction == "import" else {"empty", "replace"}
    if mode not in allowed_modes:
        raise ApiError(400, "Choose a supported transfer destination mode.")
    if not isinstance(raw_connection, str) or len(raw_connection) > 4096:
        raise ApiError(400, "Enter a valid PostgreSQL connection string.")
    if direction == "import":
        target = body.get("targetDatabase")
        tenant_resource_name(organization_id, target, "Database name")
        source = "external PostgreSQL"
        target_database = str(target)
    else:
        source = body.get("sourceDatabase")
        require_organization_database(organization_id, source)
        target_database = "external PostgreSQL"
    with transfer_lock:
        active = sum(1 for item in transfer_jobs.values() if item.get("status") in {"queued", "running", "cancelling"})
        if active >= TRANSFER_MAX_ACTIVE:
            raise ApiError(429, "Nanogres already has the maximum number of active transfers.")
        transfer_id = uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        job = {
            "transferId": transfer_id,
            "organizationPrefix": organization_prefix(organization_id),
            "organizationId": normalized_organization_id(organization_id),
            "actor": actor,
            "direction": direction,
            "targetMode": mode,
            "sourceDatabase": str(source),
            "targetDatabase": target_database,
            "status": "queued",
            "phase": "queued",
            "message": "Waiting to start",
            "createdAt": now,
            "updatedAt": now,
        }
        transfer_jobs[transfer_id] = job
        transfer_cancel_events[transfer_id] = threading.Event()
        _write_transfer_metadata(job)
        worker = threading.Thread(
            target=_run_transfer_job,
            args=(transfer_id, raw_connection),
            daemon=True,
            name=f"nanogres-transfer-{transfer_id[:8]}",
        )
        transfer_workers[transfer_id] = worker
        worker.start()
    return _public_transfer_job(job)


def cancel_transfer_job(transfer_id: str, organization_id: object) -> dict[str, object]:
    job = _load_transfer_job(transfer_id, organization_id)
    with transfer_lock:
        current = transfer_jobs.get(transfer_id, job)
        if current.get("status") not in {"queued", "running", "cancelling"}:
            raise ApiError(409, "This transfer has already finished.")
        if (
            current.get("swapStarted") is True
            or str(current.get("phase", "")).startswith("recovering")
            or current.get("phase") == "restoring_external_rollback_copy"
        ):
            raise ApiError(409, "This transfer is in its final replacement step and can no longer be cancelled safely.")
        event = transfer_cancel_events.get(transfer_id)
        if event:
            event.set()
        process = transfer_processes.get(transfer_id)
        if process and process.poll() is None:
            process.terminate()
        current.update({"phase": "cancelling", "message": "Cancelling transfer"})
        current["updatedAt"] = datetime.now(timezone.utc).isoformat()
        transfer_jobs[transfer_id] = current
        _write_transfer_metadata(current)
        return _public_transfer_job(current)


def _transfer_database_exists(name: str) -> bool:
    return run_sql(
        f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(name)})"
    ) == "t"


def _drop_transfer_database(name: str) -> None:
    if not _transfer_database_exists(name):
        return
    run_sql(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname = {quote_literal(name)} AND pid <> pg_backend_pid()"
    )
    run_sql(f"DROP DATABASE {quote_identifier(name)}")


def _recover_import_database(job: dict[str, object], was_active: bool) -> None:
    transfer_id = str(job.get("transferId", ""))
    organization_id = job.get("organizationId")
    target_value = job.get("targetDatabase")
    if not TRANSFER_JOB_PATTERN.fullmatch(transfer_id) or not isinstance(organization_id, str):
        return
    try:
        target_name = organization_database_name(organization_id, target_value)
    except ApiError:
        return
    prefix = organization_prefix(organization_id)
    staging_name = prefix + "transfer_" + transfer_id[:24]
    backup_name = prefix + "transfer_old_" + transfer_id[:24]
    try:
        stage_exists = _transfer_database_exists(staging_name)
        backup_exists = _transfer_database_exists(backup_name)
        target_exists = _transfer_database_exists(target_name)
        status = str(job.get("status", "failed"))
        if backup_exists and target_exists:
            _drop_transfer_database(backup_name)
            _drop_transfer_database(staging_name)
            succeeded = True
        elif backup_exists:
            run_sql(f"ALTER DATABASE {quote_identifier(backup_name)} RENAME TO {quote_identifier(target_name)}")
            _drop_transfer_database(staging_name)
            succeeded = False
        elif (
            target_exists
            and not stage_exists
            and job.get("swapAttempted") is True
            and (job.get("targetMode") == "new" or job.get("newDatabaseRenamed") is True)
        ):
            succeeded = True
        else:
            _drop_transfer_database(staging_name)
            succeeded = False

        if was_active:
            now = datetime.now(timezone.utc).isoformat()
            if succeeded:
                _update_transfer_job(
                    transfer_id,
                    status="succeeded",
                    phase="complete",
                    message="Transfer completed before the VPS restarted",
                    completedAt=now,
                )
                record_event(
                    "database.imported_recovered",
                    f"Recovered completed database import as {target_value} after a VPS restart.",
                    str(job.get("actor")),
                    organization_id,
                )
            else:
                _update_transfer_job(
                    transfer_id,
                    status="failed",
                    phase="failed",
                    message="The VPS restarted before this transfer completed; the previous database was preserved.",
                    completedAt=now,
                )
        elif status not in {"failed", "succeeded", "cancelled"}:
            _update_transfer_job(
                transfer_id,
                status="failed",
                phase="failed",
                message="The VPS restarted before this transfer completed; the previous database was preserved.",
                completedAt=datetime.now(timezone.utc).isoformat(),
            )
    except (ApiError, OSError, subprocess.SubprocessError):
        if was_active:
            _update_transfer_job(
                transfer_id,
                status="failed",
                phase="failed",
                message="The VPS restarted during database replacement; inspect this database before retrying.",
                completedAt=datetime.now(timezone.utc).isoformat(),
            )


def initialize_transfer_jobs() -> None:
    TRANSFER_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(TRANSFER_DIR, 0o700)
    for path in TRANSFER_DIR.glob("[0-9a-f]" * 32 + ".json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(job, dict):
            continue
        transfer_jobs[str(job.get("transferId", ""))] = job
        was_active = job.get("status") in {"queued", "running", "cancelling"}
        if job.get("direction") == "import":
            _recover_import_database(job, was_active)
        elif was_active:
            _update_transfer_job(
                str(job.get("transferId", "")),
                status="failed",
                phase="failed",
                message="The VPS restarted before this transfer completed.",
                completedAt=datetime.now(timezone.utc).isoformat(),
            )
    for path in TRANSFER_DIR.iterdir():
        if path.is_dir() and TRANSFER_JOB_PATTERN.fullmatch(path.name):
            shutil.rmtree(path, ignore_errors=True)


def organization_query_env(organization_id: object) -> dict[str, str]:
    org_id = normalized_organization_id(organization_id)
    role_name = ensure_organization_query_role(org_id)
    api_token = os.environ["NANOGRES_API_TOKEN"]
    password = hmac.new(
        api_token.encode("utf-8"),
        f"nanogres-query:{org_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    env = pg_client_env("10")
    env.update({"PGHOST": "127.0.0.1", "PGSSLMODE": "disable", "PGUSER": role_name, "PGPASSWORD": password})
    return env


def public_tenant_databases(
    organization_id: object, databases: list[dict[str, object]]
) -> list[dict[str, object]]:
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
        if TRANSFER_INTERNAL_PATTERN.fullmatch(physical_name[len(prefix):]):
            continue
        owner = database.get("owner")
        if owner == query_role:
            owner = "Nanogres"
        else:
            owner = tenant_resource_label(organization_id, owner) or owner
        result.append({
            **database,
            "name": physical_name[len(prefix):],
            "connectionName": physical_name,
            "owner": owner,
        })
    return result


def quota_growth_bytes(requested_max_bytes: int, used_bytes: int) -> int:
    requested_kib = (requested_max_bytes + 1023) // 1024
    used_kib = used_bytes // 1024
    return max(0, requested_kib - used_kib) * 1024


def run_sql(
    statement: str,
    database: str = "postgres",
    env: dict[str, str] | None = None,
) -> str:
    if not NAME_PATTERN.fullmatch(database) and database not in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Invalid database name.")
    command = [
        pg_client("psql"),
        "--no-psqlrc",
        "--no-align",
        "--tuples-only",
        "--quiet",
        "--set=ON_ERROR_STOP=1",
        "--dbname",
        database,
        "--command",
        statement,
    ]
    environment = env if env is not None else pg_client_env("5")
    result = subprocess.run(command, capture_output=True, text=True, env=environment, timeout=20)
    if result.returncode:
        # Do not return SQL text or PostgreSQL internals to callers.
        raise ApiError(400, "PostgreSQL rejected the operation.")
    return result.stdout.strip()


def json_query(statement: str, database: str = "postgres") -> object:
    output = run_sql(statement, database)
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise ApiError(503, "PostgreSQL returned an invalid response.") from error


def list_databases() -> list[dict[str, object]]:
    rows = json_query(
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


def add_database_growth_targets(
    databases: list[dict[str, object]], free_bytes: int
) -> list[dict[str, object]]:
    if not 1 <= DATABASE_GROWTH_PERCENT <= 50:
        raise ApiError(503, "Database growth percentage must be between 1 and 50.")

    user_databases = [database for database in databases if not database.get("systemDatabase")]
    growth_budget = max(0, free_bytes - DATABASE_QUOTA_RESERVE_BYTES) * DATABASE_GROWTH_PERCENT // 100
    policy = read_quota_policy()
    quota_state = read_status_file(QUOTA_STATUS_FILE)
    active_user_names = {str(database["name"]) for database in user_databases}
    policy = {name: value for name, value in policy.items() if name in active_user_names}
    quota_databases = quota_state.get("databases", {})
    if not isinstance(quota_databases, dict):
        quota_databases = {}

    quota_by_name = {
        str(quota.get("database")): quota
        for quota in quota_databases.values()
        if isinstance(quota, dict) and isinstance(quota.get("database"), str)
    }
    used_by_name: dict[str, int] = {}
    for database in user_databases:
        name = str(database["name"])
        quota = quota_by_name.get(name)
        enforced = (
            quota_state.get("enabled") is True
            and isinstance(quota, dict)
            and quota.get("hardLimitEnforced") is True
        )
        used_by_name[name] = max(
            0,
            int(
                quota.get("usedBytes", database.get("sizeBytes", 0))
                if enforced and isinstance(quota, dict)
                else database.get("sizeBytes", 0)
            ),
        )
    custom_growth_by_name = {
        name: quota_growth_bytes(requested_bytes, used_by_name.get(name, 0))
        for name, requested_bytes in policy.items()
    }
    automatic_count = sum(1 for database in user_databases if str(database["name"]) not in policy)
    automatic_headroom = max(0, growth_budget - sum(custom_growth_by_name.values()))
    per_database_headroom = automatic_headroom // automatic_count if automatic_count else 0

    for database in databases:
        size_bytes = int(database.get("sizeBytes", 0))
        name = str(database["name"])
        system_database = bool(database.get("systemDatabase"))
        requested_max_bytes = policy.get(name)
        headroom = 0 if system_database else (
            max(0, requested_max_bytes - used_by_name.get(name, size_bytes))
            if requested_max_bytes is not None
            else per_database_headroom
        )
        database["growthHeadroomBytes"] = headroom
        database["recommendedMaxBytes"] = size_bytes + headroom
        database.pop("quotaId", None)
        quota = quota_by_name.get(name)
        enforced = (
            not system_database
            and quota_state.get("enabled") is True
            and isinstance(quota, dict)
            and quota.get("hardLimitEnforced") is True
        )
        database["hardLimitEnforced"] = enforced
        database["quotaMode"] = "custom" if requested_max_bytes is not None else "auto"
        database["requestedMaxBytes"] = requested_max_bytes
        used_bytes = used_by_name.get(name, size_bytes)
        database["quotaUsedBytes"] = used_bytes if enforced else size_bytes
        other_custom_growth = sum(
            headroom
            for other_name, headroom in custom_growth_by_name.items()
            if other_name != name
        )
        maximum_custom_growth = max(0, growth_budget - other_custom_growth) // 1024 * 1024
        database["maximumCustomMaxBytes"] = (
            used_bytes + maximum_custom_growth if not system_database else 0
        )
        database["quotaConstrained"] = bool(quota.get("quotaConstrained", False)) if isinstance(quota, dict) else False
        if enforced and isinstance(quota, dict):
            quota_used = max(0, int(quota.get("usedBytes", size_bytes)))
            hard_limit = max(quota_used, int(quota.get("hardLimitBytes", quota_used)))
            database["quotaUsedBytes"] = quota_used
            database["growthHeadroomBytes"] = max(0, hard_limit - quota_used)
            database["recommendedMaxBytes"] = hard_limit
            database["quotaConstrained"] = bool(quota.get("quotaConstrained", False))
    return databases


def read_status_file(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def read_quota_policy() -> dict[str, int]:
    try:
        data = json.loads(QUOTA_POLICY_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(503, "The database quota settings could not be read.") from error

    if (
        not isinstance(data, dict)
        or type(data.get("version")) is not int
        or data.get("version") != 1
        or not isinstance(data.get("databases"), dict)
    ):
        raise ApiError(503, "The database quota settings have an unsupported format.")

    policy: dict[str, int] = {}
    for name, entry in data["databases"].items():
        if (
            not isinstance(name, str)
            or not NAME_PATTERN.fullmatch(name)
            or not isinstance(entry, dict)
            or entry.get("mode") != "custom"
            or type(entry.get("maxBytes")) is not int
            or entry["maxBytes"] <= 0
        ):
            raise ApiError(503, "The database quota settings contain an invalid entry.")
        policy[name] = entry["maxBytes"]
    return policy


def write_quota_policy(policy: dict[str, int]) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".database-quota-policy.", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "version": 1,
                    "databases": {
                        name: {"mode": "custom", "maxBytes": max_bytes}
                        for name, max_bytes in sorted(policy.items())
                    },
                },
                handle,
                separators=(",", ":"),
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, QUOTA_POLICY_FILE)
    finally:
        Path(temporary).unlink(missing_ok=True)


def clear_database_quota_setting(database: str) -> None:
    policy = read_quota_policy()
    if database in policy:
        policy.pop(database)
        write_quota_policy(policy)


def parse_status_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def calculate_offsite_backup_status(
    saved: dict[str, object],
    configured: bool,
    now: datetime | None = None,
) -> dict[str, object]:
    now = now or datetime.now(timezone.utc)
    last_attempt = parse_status_timestamp(saved.get("lastAttemptAt"))
    last_success = parse_status_timestamp(saved.get("lastSuccessAt"))
    age_seconds = (
        max(0, int((now - last_success).total_seconds())) if last_success is not None else None
    )
    last_error = saved.get("lastError")
    last_error = last_error if isinstance(last_error, str) else None
    attempt_failed = bool(last_error) and (
        last_attempt is None or last_success is None or last_attempt >= last_success
    )

    if not configured:
        freshness = "not-configured"
        last_error = None
    elif attempt_failed:
        freshness = "error"
    elif last_success is None:
        freshness = "pending"
    elif age_seconds is not None and age_seconds > OFFSITE_BACKUP_MAX_AGE.total_seconds():
        freshness = "stale"
    else:
        freshness = "fresh"

    return {
        "configured": configured,
        "lastAttemptAt": saved.get("lastAttemptAt"),
        "lastSuccessAt": saved.get("lastSuccessAt"),
        "lastSuccessAgeSeconds": age_seconds,
        "backupCount": int(saved.get("backupCount", 0) or 0),
        "storedBytes": int(saved.get("storedBytes", 0) or 0),
        "lastError": last_error if configured else None,
        "freshness": freshness,
    }


def offsite_backup_status() -> dict[str, object]:
    saved = read_status_file(OFFSITE_STATUS_FILE)
    configured = OFFSITE_ENV_FILE.is_file() and OFFSITE_ENV_FILE.stat().st_size > 0
    return calculate_offsite_backup_status(saved, configured)


def request_quota_reconcile(
    database: str | None = None,
    expected_mode: str | None = None,
    expected_max_bytes: int | None = None,
) -> None:
    previous = read_status_file(QUOTA_STATUS_FILE)
    try:
        QUOTA_REQUEST_FILE.touch(mode=0o600, exist_ok=True)
        if not (previous.get("filesystemEnabled") is True or previous.get("enabled") is True) or not database:
            return
        identifier = run_sql(
            f"SELECT oid FROM pg_database WHERE datname = {quote_literal(database)}"
        )
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            state = read_status_file(QUOTA_STATUS_FILE)
            quotas = state.get("databases", {})
            if (
                state.get("enabled") is True
                and isinstance(quotas, dict)
                and isinstance(quotas.get(identifier), dict)
                and quotas[identifier].get("hardLimitEnforced") is True
            ):
                quota = quotas[identifier]
                if (
                    (expected_mode is None or quota.get("quotaMode") == expected_mode)
                    and (
                        expected_max_bytes is None
                        or quota.get("requestedMaxBytes") == expected_max_bytes
                    )
                ):
                    return
            time.sleep(0.25)
        raise ApiError(503, "The database storage limit could not be verified. Try again shortly.")
    except OSError:
        if previous.get("filesystemEnabled") is True or previous.get("enabled") is True:
            raise ApiError(503, "The database storage limit could not be verified. Try again shortly.")


def request_offsite_backup() -> None:
    if not OFFSITE_ENV_FILE.is_file() or OFFSITE_ENV_FILE.stat().st_size == 0:
        return
    try:
        OFFSITE_REQUEST_FILE.touch(mode=0o600, exist_ok=True)
    except OSError:
        # The local backup is still available; the offsite status remains explicit.
        return


def list_roles(organization_id: object) -> list[dict[str, object]]:
    prefix = organization_prefix(organization_id)
    rows = json_query(
        f"""
        SELECT COALESCE(json_agg(row_to_json(items) ORDER BY items.name), '[]'::json)::text
        FROM (
          SELECT r.rolname AS name,
                 r.rolsuper AS superuser,
                 r.rolcreatedb AS "canCreateDatabase",
                 r.rolcreaterole AS "canCreateRole",
                 r.rolvaliduntil AS "validUntil",
                 r.rolname = 'postgres' AS "systemRole",
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
    internal_role = organization_query_role(organization_id)
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
                "databases": logical_databases,
            }
        )
    return result


def list_backups(organization_id: object) -> list[dict[str, object]]:
    backup_dir = organization_backup_dir(organization_id)
    backup_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, object]] = []
    for path in backup_dir.iterdir():
        match = BACKUP_PATTERN.fullmatch(path.name)
        if not match or not path.is_file() or path.is_symlink():
            continue
        stat = path.stat()
        entries.append(
            {
                "filename": path.name,
                "database": match.group(1),
                "createdAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                "sizeBytes": stat.st_size,
            }
        )
    return sorted(entries, key=lambda entry: str(entry["createdAt"]), reverse=True)


def list_activity(
    organization_id: object,
    limit: int = 50,
) -> list[dict[str, object]]:
    if limit <= 0 or not EVENTS_FILE.exists():
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
            if (
                isinstance(event, dict)
                and (
                    str(event.get("organizationId", "")).lower() == org_id
                    or event.get("organizationPrefix") == prefix
                )
            ):
                matches.append(event)

        with EVENTS_FILE.open("rb") as handle:
            position = handle.seek(0, os.SEEK_END)
            scan_start = max(0, position - ACTIVITY_SCAN_MAX_BYTES)
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
    STATE_DIR.mkdir(parents=True, exist_ok=True)
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
        with EVENTS_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        os.chmod(EVENTS_FILE, 0o600)


def inspect_user_query(sql: str) -> list[str]:
    """Return unquoted SQL words and reject scripts with more than one statement."""
    words: list[str] = []
    index = 0
    statement_ended = False
    length = len(sql)

    while index < length:
        char = sql[index]

        if char.isspace():
            index += 1
            continue
        if sql.startswith("--", index):
            newline = sql.find("\n", index + 2)
            index = length if newline < 0 else newline + 1
            continue
        if sql.startswith("/*", index):
            depth = 1
            index += 2
            while index < length and depth:
                if sql.startswith("/*", index):
                    depth += 1
                    index += 2
                elif sql.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise ApiError(400, "Query contains an unterminated comment.")
            continue
        if char == ";":
            statement_ended = True
            index += 1
            continue
        if statement_ended:
            raise ApiError(400, "Run one SQL statement at a time.")

        if char == "'":
            escape_string = index > 0 and sql[index - 1] in "Ee" and (
                index < 2 or not re.match(r"[A-Za-z0-9_$]", sql[index - 2])
            )
            index += 1
            while index < length:
                if escape_string and sql[index] == "\\":
                    index += 2
                    continue
                if sql[index] == "'":
                    if index + 1 < length and sql[index + 1] == "'":
                        index += 2
                    else:
                        index += 1
                        break
                else:
                    index += 1
            else:
                raise ApiError(400, "Query contains an unterminated string.")
            continue

        if char == '"':
            index += 1
            while index < length:
                if sql[index] == '"':
                    if index + 1 < length and sql[index + 1] == '"':
                        index += 2
                    else:
                        index += 1
                        break
                else:
                    index += 1
            else:
                raise ApiError(400, "Query contains an unterminated identifier.")
            continue

        if char == "$":
            delimiter = re.match(r"\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$", sql[index:])
            if delimiter:
                marker = delimiter.group(0)
                end = sql.find(marker, index + len(marker))
                if end < 0:
                    raise ApiError(400, "Query contains an unterminated dollar-quoted string.")
                index = end + len(marker)
                continue

        # psql -c can execute meta-commands such as `\!` as local shell commands.
        # A bare backslash is not valid SQL; strings and comments were skipped
        # above, so reject it before passing the text to psql.
        if char == "\\":
            raise ApiError(400, "psql meta-commands are not supported; submit SQL only.")

        word = re.match(r"[A-Za-z_][A-Za-z_0-9]*", sql[index:])
        if word:
            words.append(word.group(0).upper())
            index += len(word.group(0))
            continue

        index += 1

    if not words:
        raise ApiError(400, "Query cannot be empty.")
    return words


def complete_csv_prefix(output: str) -> str:
    """Keep only complete CSV records when output was cut at the byte limit."""
    in_quotes = False
    last_record_end = 0
    index = 0
    while index < len(output):
        char = output[index]
        if char == '"':
            if in_quotes and index + 1 < len(output) and output[index + 1] == '"':
                index += 2
                continue
            in_quotes = not in_quotes
        elif char == "\n" and not in_quotes:
            last_record_end = index + 1
        index += 1
    return output[:last_record_end]


def run_user_query(
    sql: str,
    organization_id: object,
    database: str,
    read_only: bool = False,
    timeout_seconds: int = 15,
    max_rows: int = 100,
) -> dict[str, object]:
    database = require_organization_database(organization_id, database)
    if not sql or not sql.strip():
        raise ApiError(400, "Query cannot be empty.")

    words = inspect_user_query(sql)
    if words[0] == "COPY":
        raise ApiError(400, "COPY commands are not supported in the SQL editor.")

    timeout_seconds = min(60, max(1, int(timeout_seconds)))
    max_rows = min(1000, max(1, int(max_rows)))
    timeout_ms = timeout_seconds * 1000

    if read_only:
        if words[0] not in {"SELECT", "WITH", "VALUES", "SHOW", "EXPLAIN"}:
            raise ApiError(400, "Read-only mode accepts SELECT, WITH, VALUES, SHOW, or EXPLAIN queries.")
        if any(word in {"INSERT", "UPDATE", "DELETE", "MERGE", "CALL", "DO", "COPY"} for word in words):
            raise ApiError(400, "Read-only mode cannot execute data-changing statements.")
        full_sql = f"BEGIN READ ONLY;\n{sql}"
    else:
        full_sql = sql

    max_output_bytes = 4 * 1024 * 1024
    command = [
        pg_client("psql"),
        "--no-psqlrc",
        "--quiet",
        "--csv",
        "--set=ON_ERROR_STOP=1",
        f"--set=FETCH_COUNT={max_rows + 1}",
        "--dbname",
        database,
        "--command",
        full_sql,
    ]
    env = organization_query_env(organization_id)
    env["PGOPTIONS"] = f"-c statement_timeout={timeout_ms}"
    start_time = time.perf_counter()
    try:
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as stderr_file:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=stderr_file,
                env=env,
                bufsize=0,
            )
            assert process.stdout is not None
            output_bytes = bytearray()
            output_truncated = False
            deadline = time.monotonic() + timeout_seconds + 5

            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        process.kill()
                        process.wait()
                        raise ApiError(504, f"Query exceeded execution timeout ({timeout_seconds}s).")

                    ready = selector.select(timeout=min(remaining, 1.0))
                    if not ready:
                        if process.poll() is not None:
                            continue
                        continue

                    chunk = os.read(process.stdout.fileno(), min(65536, max_output_bytes + 1 - len(output_bytes)))
                    if not chunk:
                        break
                    output_bytes.extend(chunk)
                    if len(output_bytes) > max_output_bytes:
                        output_truncated = True
                        process.kill()
                        break

            process.wait()
            stderr_file.seek(0)
            stderr = stderr_file.read().strip()
    except ApiError:
        raise
    except OSError as error:
        raise ApiError(503, "Nanogres could not start PostgreSQL query execution.") from error

    duration_ms = round((time.perf_counter() - start_time) * 1000, 2)

    if process.returncode != 0 and not output_truncated:
        clean_err = re.sub(r"^psql:[^:]+:[0-9]+:\s*", "", stderr)
        raise ApiError(400, clean_err if clean_err else "Query execution failed.")

    output = bytes(output_bytes[:max_output_bytes]).decode("utf-8", errors="replace")
    if output_truncated:
        output = complete_csv_prefix(output)

    if not output.strip():
        return {
            "columns": [],
            "rows": [],
            "rowCount": 0,
            "durationMs": duration_ms,
            "commandTag": "SUCCESS",
            "truncated": output_truncated,
        }

    try:
        reader = csv.reader(io.StringIO(output))
        columns = next(reader, [])
        data_rows: list[list[str]] = []
        row_truncated = False
        for row in reader:
            if len(data_rows) >= max_rows:
                row_truncated = True
                break
            data_rows.append(row)
        return {
            "columns": columns,
            "rows": data_rows,
            "rowCount": len(data_rows),
            "durationMs": duration_ms,
            "truncated": output_truncated or row_truncated,
        }
    except csv.Error as error:
        raise ApiError(413, "Query output contains a CSV field that is too large.") from error


def get_database_schema(database: str) -> dict[str, object]:
    if not NAME_PATTERN.fullmatch(database) and database != "postgres":
        raise ApiError(400, "Invalid database name.")
    schema_sql = """
    SELECT json_build_object(
      'schemas', (
        SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json)
        FROM (
          SELECT n.nspname AS name,
                 (
                   SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json)
                   FROM (
                     SELECT c.relname AS name,
                            c.relkind AS kind,
                            c.reltuples::bigint AS "estimatedRows",
                            pg_total_relation_size(c.oid) AS "totalSizeBytes",
                            pg_relation_size(c.oid) AS "tableSizeBytes",
                            pg_indexes_size(c.oid) AS "indexSizeBytes",
                            (
                              SELECT COALESCE(json_agg(row_to_json(col) ORDER BY col."ordinalPosition"), '[]'::json)
                              FROM (
                                SELECT a.attname AS name,
                                       pg_catalog.format_type(a.atttypid, a.atttypmod) AS "type",
                                       NOT a.attnotnull AS nullable,
                                       pg_get_expr(ad.adbin, ad.adrelid) AS "defaultValue",
                                       a.attnum AS "ordinalPosition",
                                       EXISTS (
                                         SELECT 1 FROM pg_constraint con
                                         WHERE con.conrelid = c.oid AND con.contype = 'p' AND a.attnum = ANY(con.conkey)
                                       ) AS "isPrimaryKey",
                                       EXISTS (
                                         SELECT 1 FROM pg_constraint con
                                         WHERE con.conrelid = c.oid AND con.contype = 'f' AND a.attnum = ANY(con.conkey)
                                       ) AS "isForeignKey"
                                FROM pg_attribute a
                                LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                              ) col
                            ) AS columns,
                            (
                              SELECT COALESCE(json_agg(row_to_json(idx) ORDER BY idx.name), '[]'::json)
                              FROM (
                                SELECT i.relname AS name,
                                       pg_get_indexdef(i.oid) AS definition,
                                       pg_relation_size(i.oid) AS "sizeBytes",
                                       ix.indisunique AS "isUnique",
                                       ix.indisprimary AS "isPrimary"
                                FROM pg_index ix
                                JOIN pg_class i ON i.oid = ix.indexrelid
                                WHERE ix.indrelid = c.oid
                              ) idx
                            ) AS indexes
                     FROM pg_class c
                     WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'v', 'm', 'p')
                   ) t
                 ) AS tables
          FROM pg_namespace n
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY n.nspname
        ) s
      )
    )::text
    """
    data = json_query(schema_sql, database=database)
    return data if isinstance(data, dict) else {"schemas": []}


def execute_ddl(
    database: str,
    payload: dict[str, object],
    actor: str | None = None,
    organization_id: object | None = None,
) -> dict[str, object]:
    if not NAME_PATTERN.fullmatch(database) and database != "postgres":
        raise ApiError(400, "Invalid database name.")
    op = str(payload.get("operation", ""))
    database_label = (
        tenant_resource_label(organization_id, database)
        if organization_id is not None
        else database
    ) or database
    sql_env = organization_query_env(organization_id) if organization_id is not None else None
    if op == "create_table":
        table_name = valid_name(payload.get("name"), "Table name")
        columns_data = payload.get("columns")
        if not isinstance(columns_data, list) or not columns_data:
            raise ApiError(400, "Columns list cannot be empty.")
        col_defs = []
        pk_cols = []
        for col in columns_data:
            if not isinstance(col, dict):
                continue
            col_name = valid_name(col.get("name"), "Column name")
            col_type = str(col.get("type", "text")).strip().upper()
            if not re.fullmatch(r"^[A-Z0-9_ ()]+$", col_type):
                raise ApiError(400, "Invalid column type.")
            nullable = bool(col.get("nullable", True))
            definition = f"{quote_identifier(col_name)} {col_type}"
            if not nullable:
                definition += " NOT NULL"
            if col.get("primaryKey"):
                pk_cols.append(quote_identifier(col_name))
            col_defs.append(definition)
        if pk_cols:
            col_defs.append(f"PRIMARY KEY ({', '.join(pk_cols)})")
        sql = f"CREATE TABLE {quote_identifier(table_name)} (\n  " + ",\n  ".join(col_defs) + "\n);"
        run_sql(sql, database=database, env=sql_env)
        record_event(
            "table.created", f"Table {table_name} created in {database_label}.", actor, organization_id
        )
        return {"created": True, "table": table_name}

    elif op == "add_column":
        table_name = valid_name(payload.get("table"), "Table name")
        col_name = valid_name(payload.get("column"), "Column name")
        col_type = str(payload.get("type", "text")).strip().upper()
        if not re.fullmatch(r"^[A-Z0-9_ ()]+$", col_type):
            raise ApiError(400, "Invalid column type.")
        nullable = bool(payload.get("nullable", True))
        sql = f"ALTER TABLE {quote_identifier(table_name)} ADD COLUMN {quote_identifier(col_name)} {col_type}"
        if not nullable:
            sql += " NOT NULL"
        run_sql(sql, database=database, env=sql_env)
        record_event(
            "column.added", f"Column {col_name} added to {table_name} in {database_label}.", actor, organization_id
        )
        return {"added": True, "column": col_name}

    elif op == "create_index":
        table_name = valid_name(payload.get("table"), "Table name")
        idx_name = valid_name(payload.get("name"), "Index name")
        cols = payload.get("columns")
        if not isinstance(cols, list) or not cols:
            raise ApiError(400, "Index columns cannot be empty.")
        quoted_cols = [quote_identifier(valid_name(c, "Column")) for c in cols]
        unique = "UNIQUE " if payload.get("unique") else ""
        idx_type = str(payload.get("type", "btree")).lower()
        if idx_type not in {"btree", "hash", "gin", "gist"}:
            idx_type = "btree"
        sql = f"CREATE {unique}INDEX {quote_identifier(idx_name)} ON {quote_identifier(table_name)} USING {idx_type} ({', '.join(quoted_cols)});"
        run_sql(sql, database=database, env=sql_env)
        record_event(
            "index.created", f"Index {idx_name} created on {table_name} in {database_label}.", actor, organization_id
        )
        return {"created": True, "index": idx_name}

    elif op == "maintenance":
        action = str(payload.get("action", "")).lower()
        if action not in {"vacuum", "vacuum_full", "analyze", "reindex"}:
            raise ApiError(400, "Invalid maintenance action.")
        table = payload.get("table")
        if table:
            table_name = valid_name(table, "Table name")
            if action == "vacuum":
                sql = f"VACUUM {quote_identifier(table_name)}"
            elif action == "vacuum_full":
                sql = f"VACUUM FULL {quote_identifier(table_name)}"
            elif action == "analyze":
                sql = f"ANALYZE {quote_identifier(table_name)}"
            else:
                sql = f"REINDEX TABLE {quote_identifier(table_name)}"
        else:
            if action == "vacuum":
                sql = "VACUUM"
            elif action == "vacuum_full":
                sql = "VACUUM FULL"
            elif action == "analyze":
                sql = "ANALYZE"
            else:
                sql = f"REINDEX DATABASE {quote_identifier(database)}"
        run_sql(sql, database=database, env=sql_env)
        record_event(
            f"database.{action}", f"{action.upper()} executed in {database_label}.", actor, organization_id
        )
        return {"success": True, "action": action}

    raise ApiError(400, f"Unsupported operation: {op}")


def get_active_queries(
    organization_id: object,
    database: str | None = None,
) -> list[dict[str, object]]:
    prefix = organization_prefix(organization_id)
    where_clause = "WHERE a.pid <> pg_backend_pid() AND a.state IS NOT NULL"
    where_clause += f" AND left(a.datname, {len(prefix)}) = {quote_literal(prefix)}"
    if database:
        physical_name = require_organization_database(organization_id, database)
        where_clause += f" AND a.datname = {quote_literal(physical_name)}"
    sql = f"""
    SELECT COALESCE(json_agg(row_to_json(q) ORDER BY q."durationSeconds" DESC), '[]'::json)::text
    FROM (
      SELECT a.pid,
             a.usename AS "userName",
             a.datname AS "database",
             COALESCE(a.client_addr::text, 'local') AS "clientAddress",
             COALESCE(a.application_name, '') AS "applicationName",
             a.state,
             a.query_start AS "queryStart",
             COALESCE(ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start))::numeric, 2), 0) AS "durationSeconds",
             a.query,
             a.wait_event_type AS "waitEventType",
             a.wait_event AS "waitEvent"
      FROM pg_stat_activity a
      {where_clause}
    ) q
    """
    rows = json_query(sql)
    if not isinstance(rows, list):
        return []
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        logical_database = tenant_resource_label(organization_id, row.get("database"))
        physical_user = row.get("userName")
        logical_user = (
            "Nanogres"
            if physical_user == organization_query_role(organization_id)
            else tenant_resource_label(organization_id, physical_user)
        )
        result.append(
            {
                **row,
                "database": logical_database or row.get("database"),
                "userName": logical_user or physical_user,
            }
        )
    return result


def terminate_query(
    pid: int,
    organization_id: object,
    signal: str = "cancel",
    actor: str | None = None,
) -> dict[str, object]:
    if not isinstance(pid, int) or pid <= 0:
        raise ApiError(400, "Invalid process ID.")
    prefix = organization_prefix(organization_id)
    belongs_to_organization = run_sql(
        f"SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
        f"WHERE pid = {pid} AND left(datname, {len(prefix)}) = {quote_literal(prefix)})"
    )
    if belongs_to_organization != "t":
        raise ApiError(404, "Query not found.")
    func = "pg_cancel_backend" if signal == "cancel" else "pg_terminate_backend"
    res = run_sql(f"SELECT {func}({pid})")
    success = res == "t"
    record_event(
        f"query.{signal}", f"{signal.capitalize()} sent to backend pid {pid}.", actor, organization_id
    )
    return {"success": success, "pid": pid, "action": signal}


def postgres_status() -> dict[str, object]:
    status = json_query(
        """
        SELECT json_build_object(
          'postgresVersion', current_setting('server_version'),
          'startedAt', pg_postmaster_start_time(),
          'connections', (SELECT count(*) FROM pg_stat_activity),
          'maxConnections', current_setting('max_connections')::int
        )::text
        """
    )
    if not isinstance(status, dict):
        raise ApiError(503, "PostgreSQL is unavailable.")
    data_directory = run_sql("SHOW data_directory")
    disk = shutil.disk_usage(data_directory)
    quota_state = read_status_file(QUOTA_STATUS_FILE)
    return {
        **status,
        "disk": {"totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
        "backupRetentionDays": BACKUP_RETENTION_DAYS,
        "databaseGrowthPercent": DATABASE_GROWTH_PERCENT,
        "databaseQuotaReserveBytes": int(
            quota_state.get("reserveBytes", DATABASE_QUOTA_RESERVE_BYTES)
        ),
        "databaseQuotaEnforced": quota_state.get("enabled") is True,
        "databaseQuotaReason": quota_state.get("reason"),
        "databaseQuotaCheckedAt": quota_state.get("lastReconciledAt"),
        "offsiteBackup": offsite_backup_status(),
    }


def cleanup_old_backups() -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=BACKUP_RETENTION_DAYS)
    removed = 0
    if not BACKUP_DIR.exists():
        return removed
    for path in BACKUP_DIR.rglob("*"):
        if not BACKUP_PATTERN.fullmatch(path.name) or path.is_symlink() or not path.is_file():
            continue
        if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < cutoff:
            path.unlink()
            removed += 1
    return removed


def _create_backup_physical(
    physical_database: str,
    display_database: str,
    backup_dir: Path,
    actor: str | None = None,
    timeout_seconds: int = 3600,
    upload_offsite: bool = True,
    organization_id: object | None = None,
    organization_prefix_value: str | None = None,
) -> dict[str, object]:
    if not NAME_PATTERN.fullmatch(physical_database) or physical_database == "postgres":
        raise ApiError(400, "Choose a user database to back up.")
    exists = run_sql(
        f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(physical_database)})"
    )
    if exists != "t":
        raise ApiError(404, "Database not found.")
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"{display_database}__{timestamp}.dump"
    final_path = backup_dir / filename
    partial_path = backup_dir / f".{filename}.partial"
    command = [
        pg_client("pg_dump"),
        "--format=custom",
        "--no-owner",
        "--file",
        str(partial_path),
        "--dbname",
        physical_database,
    ]
    env = pg_client_env("10")
    old_umask = os.umask(0o077)
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, env=env, timeout=timeout_seconds
        )
    except subprocess.TimeoutExpired as error:
        partial_path.unlink(missing_ok=True)
        raise ApiError(504, "Backup exceeded its time limit.") from error
    finally:
        os.umask(old_umask)
    if result.returncode:
        partial_path.unlink(missing_ok=True)
        raise ApiError(503, "PostgreSQL could not create the backup.")
    os.chmod(partial_path, 0o600)
    partial_path.replace(final_path)
    cleanup_old_backups()
    record_event(
        "backup.created",
        f"Backup created for {display_database}.",
        actor,
        organization_id,
        organization_prefix_value,
    )
    if upload_offsite:
        request_offsite_backup()
    return {
        "filename": filename,
        "database": display_database,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sizeBytes": final_path.stat().st_size,
    }


def create_backup(
    organization_id: object,
    database: object,
    actor: str | None = None,
    timeout_seconds: int = 3600,
    upload_offsite: bool = True,
) -> dict[str, object]:
    tenant_resource_name(organization_id, database, "Database name")
    physical_name = organization_database_name(organization_id, database)
    return _create_backup_physical(
        physical_name,
        str(database),
        organization_backup_dir(organization_id),
        actor,
        timeout_seconds,
        upload_offsite,
        organization_id,
    )


def restore_backup(
    organization_id: object,
    encoded_name: str,
    target: object,
    actor: str | None = None,
) -> dict[str, object]:
    filename = unquote(encoded_name)
    match = BACKUP_PATTERN.fullmatch(filename)
    if not match:
        raise ApiError(404, "Backup not found.")
    tenant_resource_name(organization_id, match.group(1), "Backup database name")
    logical_target = str(target) if isinstance(target, str) else ""
    target_name = organization_database_name(organization_id, logical_target)
    query_role = ensure_organization_query_role(organization_id)

    backup_path = organization_backup_dir(organization_id) / filename
    if not backup_path.is_file() or backup_path.is_symlink():
        raise ApiError(404, "Backup not found.")

    with backup_lock:
        with quota_policy_lock:
            if run_sql(
                f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(target_name)})"
            ) == "t":
                raise ApiError(409, "A database with that name already exists. Restore never overwrites a database.")

            clear_database_quota_setting(target_name)
            run_sql(
                f"CREATE DATABASE {quote_identifier(target_name)} OWNER {quote_identifier(query_role)} ENCODING 'UTF8' TEMPLATE template0"
            )
            prepare_organization_database(organization_id, target_name)
            try:
                request_quota_reconcile(target_name)
            except ApiError:
                run_sql(f"DROP DATABASE {quote_identifier(target_name)}")
                raise
        command = [
            pg_client("pg_restore"),
            "--exit-on-error",
            "--single-transaction",
            "--no-owner",
            "--no-acl",
            "--dbname",
            target_name,
            str(backup_path),
        ]
        env = organization_query_env(organization_id)
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                env=env,
                timeout=240,
            )
        except subprocess.TimeoutExpired:
            result = None

        if result is None or result.returncode:
            try:
                run_sql(f"DROP DATABASE {quote_identifier(target_name)}")
            except (ApiError, OSError, subprocess.SubprocessError):
                raise ApiError(
                    503,
                    "Restore failed; the new database may be incomplete and needs cleanup.",
                )
            raise ApiError(503, "Restore failed; the new database was removed.")
        transfer_database_objects(target_name, query_role)

    record_event(
        "backup.restored",
        f"Backup {filename} restored as new database {logical_target}.",
        actor,
        organization_id,
    )
    return {"database": logical_target, "restoredFrom": filename}


def cleanup_old_restore_uploads() -> int:
    removed = 0
    if not RESTORE_UPLOAD_DIR.exists():
        return removed
    cutoff = datetime.now(timezone.utc) - RESTORE_UPLOAD_TTL
    for path in RESTORE_UPLOAD_DIR.iterdir():
        if not UPLOAD_ID_PATTERN.fullmatch(path.name) or path.is_symlink() or not path.is_dir():
            continue
        if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < cutoff:
            shutil.rmtree(path)
            removed += 1
    return removed


def restore_upload_path(upload_id: str) -> Path:
    if not UPLOAD_ID_PATTERN.fullmatch(upload_id):
        raise ApiError(404, "Restore upload not found.")
    path = RESTORE_UPLOAD_DIR / upload_id
    if not path.is_dir() or path.is_symlink():
        raise ApiError(404, "Restore upload not found.")
    return path


def read_restore_upload(
    upload_id: str,
    organization_id: object,
) -> tuple[Path, dict[str, int]]:
    path = restore_upload_path(upload_id)
    try:
        metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(404, "Restore upload not found.") from error
    size_bytes = metadata.get("sizeBytes") if isinstance(metadata, dict) else None
    expected_prefix = organization_prefix(organization_id)
    if not isinstance(metadata, dict) or metadata.get("organizationPrefix") != expected_prefix:
        raise ApiError(404, "Restore upload not found.")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        raise ApiError(400, "Restore upload metadata is invalid.")
    chunk_count = (size_bytes + TRANSFER_CHUNK_BYTES - 1) // TRANSFER_CHUNK_BYTES
    return path, {"sizeBytes": size_bytes, "chunkCount": chunk_count}


def create_restore_upload(
    body: dict[str, object],
    organization_id: object,
) -> dict[str, object]:
    size_bytes = body.get("sizeBytes")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        raise ApiError(400, "Choose a non-empty PostgreSQL dump file.")

    RESTORE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    cleanup_old_restore_uploads()
    if shutil.disk_usage(STATE_DIR).free < size_bytes + RESTORE_UPLOAD_DISK_RESERVE_BYTES:
        raise ApiError(413, "There is not enough free VPS disk space for this upload.")

    upload_id = uuid.uuid4().hex
    upload_path = RESTORE_UPLOAD_DIR / upload_id
    upload_path.mkdir(mode=0o700)
    metadata_path = upload_path / "metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "sizeBytes": size_bytes,
                "organizationPrefix": organization_prefix(organization_id),
            }
        ),
        encoding="utf-8",
    )
    os.chmod(metadata_path, 0o600)
    return {
        "uploadId": upload_id,
        "chunkSizeBytes": TRANSFER_CHUNK_BYTES,
        "chunkCount": (size_bytes + TRANSFER_CHUNK_BYTES - 1) // TRANSFER_CHUNK_BYTES,
    }


def store_restore_chunk(
    upload_id: str,
    chunk_index: int,
    body: bytes,
    organization_id: object,
) -> dict[str, int]:
    upload_path, metadata = read_restore_upload(upload_id, organization_id)
    chunk_count = metadata["chunkCount"]
    if chunk_index < 0 or chunk_index >= chunk_count:
        raise ApiError(404, "Restore upload chunk not found.")
    expected_size = min(
        TRANSFER_CHUNK_BYTES,
        metadata["sizeBytes"] - chunk_index * TRANSFER_CHUNK_BYTES,
    )
    if len(body) != expected_size:
        raise ApiError(400, "Restore upload chunk has an unexpected size.")

    chunk_path = upload_path / f"chunk-{chunk_index:08d}.part"
    partial_path = upload_path / f".chunk-{chunk_index:08d}.partial"
    partial_path.write_bytes(body)
    os.chmod(partial_path, 0o600)
    partial_path.replace(chunk_path)
    return {"chunkIndex": chunk_index, "receivedBytes": len(body)}


def run_pg_restore_from_upload(
    command: list[str],
    upload_path: Path,
    chunk_count: int,
    timeout_seconds: int,
    env: dict[str, str] | None = None,
) -> int | None:
    env = env or pg_client_env("10")
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    if process.stdin is None:
        process.kill()
        process.wait()
        raise ApiError(503, "PostgreSQL could not read the uploaded backup.")

    feed_errors: list[Exception] = []

    def feed_archive() -> None:
        try:
            for index in range(chunk_count):
                chunk_path = upload_path / f"chunk-{index:08d}.part"
                if not chunk_path.is_file() or chunk_path.is_symlink():
                    raise ApiError(400, "The uploaded backup is incomplete.")
                with chunk_path.open("rb") as chunk:
                    shutil.copyfileobj(chunk, process.stdin, length=1024 * 1024)
        except BrokenPipeError:
            # pg_restore can reject an invalid archive before it reads all input.
            pass
        except Exception as error:
            feed_errors.append(error)
        finally:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass

    feeder = threading.Thread(target=feed_archive, daemon=True)
    feeder.start()
    try:
        result = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        feeder.join(timeout=5)
        return None
    feeder.join()
    if feed_errors:
        if result == 0:
            raise ApiError(400, "The uploaded backup could not be read completely.")
    return result


def restore_uploaded_dump(
    upload_id: str,
    target: object,
    actor: str | None,
    organization_id: object,
) -> dict[str, object]:
    upload_path, metadata = read_restore_upload(upload_id, organization_id)
    logical_target = str(target) if isinstance(target, str) else ""
    target_name = organization_database_name(organization_id, logical_target)
    query_role = ensure_organization_query_role(organization_id)

    expected_chunks = metadata["chunkCount"]
    for index in range(expected_chunks):
        chunk_path = upload_path / f"chunk-{index:08d}.part"
        expected_size = min(
            TRANSFER_CHUNK_BYTES,
            metadata["sizeBytes"] - index * TRANSFER_CHUNK_BYTES,
        )
        if (
            chunk_path.is_symlink()
            or not chunk_path.is_file()
            or chunk_path.stat().st_size != expected_size
        ):
            raise ApiError(400, "The uploaded backup is incomplete.")

    with backup_lock:
        with quota_policy_lock:
            if run_sql(
                f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(target_name)})"
            ) == "t":
                raise ApiError(
                    409,
                    "A database with that name already exists. Restore never overwrites a database.",
                )

            clear_database_quota_setting(target_name)
            run_sql(
                f"CREATE DATABASE {quote_identifier(target_name)} OWNER {quote_identifier(query_role)} ENCODING 'UTF8' TEMPLATE template0"
            )
            prepare_organization_database(organization_id, target_name)
            try:
                request_quota_reconcile(target_name)
            except ApiError:
                run_sql(f"DROP DATABASE {quote_identifier(target_name)}")
                shutil.rmtree(upload_path, ignore_errors=True)
                raise
        result = run_pg_restore_from_upload(
            [
                pg_client("pg_restore"),
                "--exit-on-error",
                "--single-transaction",
                "--no-owner",
                "--no-acl",
                "--dbname",
                target_name,
            ],
            upload_path,
            expected_chunks,
            timeout_seconds=240,
            env=organization_query_env(organization_id),
        )
        if result is None or result != 0:
            try:
                run_sql(f"DROP DATABASE {quote_identifier(target_name)}")
            except (ApiError, OSError, subprocess.SubprocessError):
                raise ApiError(
                    503,
                    "Restore failed; the new database may be incomplete and needs cleanup.",
                )
            shutil.rmtree(upload_path, ignore_errors=True)
            raise ApiError(503, "Restore failed; the new database was removed.")
        try:
            transfer_database_objects(target_name, query_role)
        except (ApiError, OSError, subprocess.SubprocessError):
            try:
                run_sql(f"DROP DATABASE {quote_identifier(target_name)}")
            except (ApiError, OSError, subprocess.SubprocessError):
                raise ApiError(
                    503,
                    "Restore failed; the new database may be incomplete and needs cleanup.",
                )
            shutil.rmtree(upload_path, ignore_errors=True)
            raise ApiError(503, "Restore failed; the new database was removed.")

    shutil.rmtree(upload_path)
    record_event(
        "backup.restored",
        f"Uploaded PostgreSQL dump restored as new database {logical_target}.",
        actor,
        organization_id,
    )
    return {"database": logical_target, "restoredFrom": "uploaded file"}


def backup_all() -> int:
    cleanup_old_restore_uploads()
    databases = [row["name"] for row in list_databases() if row.get("name") != "postgres"]
    completed = 0
    for physical_name in databases:
        if not isinstance(physical_name, str) or not NAME_PATTERN.fullmatch(physical_name):
            continue
        match = re.fullmatch(r"(n[0-9a-f]{24}_)([a-z][a-z0-9_]{0,36})", physical_name)
        if match:
            if TRANSFER_INTERNAL_PATTERN.fullmatch(match.group(2)):
                continue
            backup_dir = BACKUP_DIR / match.group(1).rstrip("_")
            display_name = match.group(2)
        else:
            # Keep pre-tenant databases backed up until the operator migrates them.
            backup_dir = BACKUP_DIR / "legacy"
            display_name = physical_name
        _create_backup_physical(
            physical_name,
            display_name,
            backup_dir,
            upload_offsite=False,
            organization_prefix_value=match.group(1) if match else None,
        )
        completed += 1
    cleanup_old_backups()
    return completed


def valid_name(value: object, label: str) -> str:
    if not isinstance(value, str) or not NAME_PATTERN.fullmatch(value):
        raise ApiError(400, f"{label} must start with a lowercase letter and contain only lowercase letters, numbers, or underscores.")
    return value


def update_database_quota(
    organization_id: object,
    name_value: object,
    body: dict[str, object],
    actor: str | None,
) -> dict[str, object]:
    logical_name = str(name_value) if isinstance(name_value, str) else ""
    name = organization_database_name(organization_id, logical_name)

    mode = body.get("mode")
    if mode != "auto" and mode != "custom":
        raise ApiError(400, "Choose automatic or custom database sizing.")
    requested_max_bytes: int | None = None
    if mode == "custom":
        value = body.get("maxBytes")
        if type(value) is not int or value <= 0:
            raise ApiError(400, "Enter a valid maximum database size in bytes.")
        requested_max_bytes = value

    with quota_policy_lock:
        old_policy = read_quota_policy()
        status = postgres_status()
        quota_state = read_status_file(QUOTA_STATUS_FILE)
        quota_databases = quota_state.get("databases", {})
        if not isinstance(quota_databases, dict) or quota_state.get("enabled") is not True:
            raise ApiError(503, "Per-database hard quotas are not currently available.")

        rows = list_databases()
        row = next((item for item in rows if item.get("name") == name), None)
        if row is None:
            raise ApiError(404, "Database not found.")
        quota_id = str(row.get("quotaId", ""))
        quota = quota_databases.get(quota_id)
        if not isinstance(quota, dict) or quota.get("hardLimitEnforced") is not True:
            raise ApiError(503, "A hard size limit could not be confirmed for this database.")

        used_bytes = max(0, int(quota.get("usedBytes", row.get("sizeBytes", 0))))
        minimum_max_bytes = max(used_bytes, int(row.get("sizeBytes", 0)))
        growth_budget = (
            max(0, int(status["disk"]["freeBytes"]) - DATABASE_QUOTA_RESERVE_BYTES)
            * DATABASE_GROWTH_PERCENT
            // 100
        )
        growth_budget_kib = growth_budget // 1024
        row_by_name = {str(item.get("name")): item for item in rows}
        other_custom_growth_kib = 0
        for other_name, other_max_bytes in old_policy.items():
            if other_name == name:
                continue
            other_row = row_by_name.get(other_name)
            if other_row is None or other_row.get("systemDatabase"):
                continue
            other_quota = quota_databases.get(str(other_row.get("quotaId", "")))
            other_used = (
                max(0, int(other_quota.get("usedBytes", other_row.get("sizeBytes", 0))))
                if isinstance(other_quota, dict)
                else max(0, int(other_row.get("sizeBytes", 0)))
            )
            other_custom_growth_kib += quota_growth_bytes(other_max_bytes, other_used) // 1024

        new_policy = dict(old_policy)
        if mode == "auto":
            new_policy.pop(name, None)
        else:
            assert requested_max_bytes is not None
            if requested_max_bytes < minimum_max_bytes:
                raise ApiError(400, "The custom maximum cannot be smaller than current database usage.")
            maximum_available = used_bytes + max(0, growth_budget_kib - other_custom_growth_kib) * 1024
            if requested_max_bytes > maximum_available:
                raise ApiError(
                    409,
                    f"This database can currently have a custom maximum of up to {maximum_available} bytes. "
                    "Reduce another custom limit or return a database to Auto to free growth room.",
                )
            new_policy[name] = requested_max_bytes

        write_quota_policy(new_policy)
        try:
            request_quota_reconcile(
                name,
                expected_mode=str(mode),
                expected_max_bytes=requested_max_bytes,
            )
        except ApiError:
            write_quota_policy(old_policy)
            try:
                QUOTA_REQUEST_FILE.touch(mode=0o600, exist_ok=True)
            except OSError:
                pass
            raise

    description = (
        f"Database {logical_name} quota returned to Auto."
        if mode == "auto"
        else f"Database {logical_name} custom maximum set to {requested_max_bytes} bytes."
    )
    record_event("database.quota.updated", description, actor, organization_id)
    refreshed_status = postgres_status()
    databases = add_database_growth_targets(
        list_databases(), int(refreshed_status["disk"]["freeBytes"])
    )
    scoped_databases = public_tenant_databases(organization_id, databases)
    return next(item for item in scoped_databases if item["name"] == logical_name)


class Handler(BaseHTTPRequestHandler):
    server_version = "NanogresAPI/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        # Avoid access logs containing request paths or caller-supplied data.
        return

    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected = os.environ.get("NANOGRES_API_TOKEN", "")
        supplied = self.headers.get("Authorization", "")
        if len(expected) < 32:
            self._json(503, {"error": "Management API is not configured."})
            return False
        if not supplied.startswith("Bearer ") or not hmac.compare_digest(
            supplied[7:].encode("utf-8"), expected.encode("utf-8")
        ):
            self._json(401, {"error": "Unauthorized."})
            return False
        return True

    def _actor(self) -> str | None:
        actor = self.headers.get("X-Nanogres-Actor", "")
        return actor if ACTOR_PATTERN.fullmatch(actor) else None

    def _organization(self) -> str | None:
        try:
            return normalized_organization_id(
                self.headers.get("X-Nanogres-Organization", "")
            )
        except ApiError as error:
            self._json(error.status, {"error": error.message})
            return None

    def _body(self, max_length: int = 8192) -> dict[str, object]:
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ApiError(415, "Content-Type must be application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ApiError(400, "Invalid request body.") from error
        if length <= 0 or length > max_length:
            raise ApiError(413, f"Request body must be between 1 and {max_length} bytes.")
        try:
            value = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ApiError(400, "Request body must be valid JSON.") from error
        if not isinstance(value, dict):
            raise ApiError(400, "Request body must be a JSON object.")
        return value

    def do_GET(self) -> None:
        if not self._authorized():
            return
        try:
            path = urlsplit(self.path).path
            if path == "/healthz":
                self._json(200, {"ok": True, **postgres_status()})
                return
            organization_id = self._organization()
            if organization_id is None:
                return
            if path == "/v1/overview":
                status = postgres_status()
                databases = add_database_growth_targets(
                    list_databases(), int(status["disk"]["freeBytes"])
                )
                self._json(
                    200,
                    {
                        "status": status,
                        "databases": public_tenant_databases(organization_id, databases),
                        "backups": list_backups(organization_id)[:8],
                        "activity": list_activity(organization_id, 8),
                    },
                )
            elif path == "/v1/databases":
                status = postgres_status()
                databases = add_database_growth_targets(
                    list_databases(), int(status["disk"]["freeBytes"])
                )
                self._json(
                    200,
                    {
                        "status": status,
                        "databases": public_tenant_databases(organization_id, databases),
                    },
                )
            elif path == "/v1/roles":
                self._json(200, {"roles": list_roles(organization_id)})
            elif path == "/v1/backups":
                self._json(200, {"backups": list_backups(organization_id)})
            elif path == "/v1/transfers":
                self._json(200, {"transfers": list_transfer_jobs(organization_id)})
            elif re.fullmatch(r"/v1/transfers/[a-f0-9]{32}", path):
                transfer_id = path.removeprefix("/v1/transfers/")
                self._json(200, {"transfer": _public_transfer_job(_load_transfer_job(transfer_id, organization_id))})
            elif path == "/v1/activity":
                self._json(200, {"events": list_activity(organization_id)})
            elif path == "/v1/activity/queries":
                self._json(200, {"queries": get_active_queries(organization_id)})
            elif path.startswith("/v1/databases/") and path.endswith("/schema"):
                encoded_name = path.removeprefix("/v1/databases/").removesuffix("/schema")
                if "/" in encoded_name:
                    raise ApiError(404, "Route not found.")
                database = require_organization_database(organization_id, unquote(encoded_name))
                self._json(200, get_database_schema(database))
            elif path.startswith("/v1/databases/") and path.endswith("/queries"):
                encoded_name = path.removeprefix("/v1/databases/").removesuffix("/queries")
                if "/" in encoded_name:
                    raise ApiError(404, "Route not found.")
                self._json(
                    200,
                    {"queries": get_active_queries(organization_id, unquote(encoded_name))},
                )
            elif path == "/v1/events/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    try:
                        status = postgres_status()
                        payload = {
                            "type": "telemetry",
                            "status": status,
                            "activity": list_activity(organization_id, 6),
                            "timestamp": time.time(),
                        }
                        self.wfile.write(
                            f"event: telemetry\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
                        )
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    time.sleep(5)
            elif path.startswith("/v1/backups/"):
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                self._download_backup(
                    organization_id,
                    path.removeprefix("/v1/backups/"),
                    query,
                )
            else:
                self._json(404, {"error": "Route not found."})
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except (OSError, subprocess.SubprocessError):
            self._json(503, {"error": "Nanogres could not reach PostgreSQL."})

    def do_POST(self) -> None:
        if not self._authorized():
            return
        try:
            path = urlsplit(self.path).path
            organization_id = self._organization()
            if organization_id is None:
                return
            actor = self._actor()
            if path == "/v1/query":
                body = self._body(max_length=65536)
                db = str(body.get("database", ""))
                sql = str(body.get("sql", ""))
                read_only = body.get("readOnly", False)
                if not isinstance(read_only, bool):
                    raise ApiError(400, "readOnly must be a boolean.")
                try:
                    timeout = int(body.get("timeoutSeconds", 15))
                    max_rows = int(body.get("maxRows", 100))
                except (TypeError, ValueError) as error:
                    raise ApiError(400, "timeoutSeconds and maxRows must be integers.") from error
                result = run_user_query(
                    sql,
                    organization_id=organization_id,
                    database=db,
                    read_only=read_only,
                    timeout_seconds=timeout,
                    max_rows=max_rows,
                )
                record_event("query.executed", f"Query executed on {db}.", actor, organization_id)
                self._json(200, result)
                return

            body = self._body(max_length=16384 if path == "/v1/transfers" else 8192)
            if path == "/v1/databases":
                logical_name = str(body.get("name", ""))
                name = organization_database_name(organization_id, logical_name)
                query_role = ensure_organization_query_role(organization_id)
                with quota_policy_lock:
                    exists = run_sql(
                        f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(name)})"
                    )
                    if exists == "t":
                        raise ApiError(409, "A database with that name already exists.")
                    clear_database_quota_setting(name)
                    run_sql(
                        f"CREATE DATABASE {quote_identifier(name)} OWNER {quote_identifier(query_role)} ENCODING 'UTF8' TEMPLATE template0"
                    )
                    try:
                        prepare_organization_database(organization_id, name)
                        request_quota_reconcile(name)
                    except ApiError:
                        run_sql(f"DROP DATABASE {quote_identifier(name)}")
                        raise
                record_event(
                    "database.created", f"Database {logical_name} created.", actor, organization_id
                )
                status = postgres_status()
                databases = add_database_growth_targets(
                    list_databases(), int(status["disk"]["freeBytes"])
                )
                scoped_databases = public_tenant_databases(organization_id, databases)
                self._json(
                    201,
                    {
                        "database": next(
                            row for row in scoped_databases if row["name"] == logical_name
                        )
                    },
                )
            elif path.startswith("/v1/databases/") and path.endswith("/quota"):
                encoded_name = path.removeprefix("/v1/databases/").removesuffix("/quota")
                if "/" in encoded_name:
                    raise ApiError(404, "Route not found.")
                database = update_database_quota(
                    organization_id,
                    unquote(encoded_name),
                    body,
                    actor,
                )
                self._json(200, {"database": database})
            elif path == "/v1/roles":
                self._create_role(body, actor, organization_id)
            elif path == "/v1/backups":
                database = str(body.get("database", ""))
                with backup_lock:
                    backup = create_backup(
                        organization_id,
                        database,
                        actor,
                        timeout_seconds=240,
                    )
                self._json(201, {"backup": backup})
            elif path == "/v1/transfers":
                self._json(202, {"transfer": create_transfer_job(body, organization_id, actor)})
            elif path.startswith("/v1/backups/") and path.endswith("/restore"):
                encoded_name = path.removeprefix("/v1/backups/").removesuffix("/restore")
                restored = restore_backup(
                    organization_id,
                    encoded_name,
                    body.get("database"),
                    actor,
                )
                self._json(201, restored)
            elif path == "/v1/restore-uploads":
                self._json(201, create_restore_upload(body, organization_id))
            elif path.startswith("/v1/restore-uploads/") and path.endswith("/complete"):
                upload_id = path.removeprefix("/v1/restore-uploads/").removesuffix("/complete")
                restored = restore_uploaded_dump(
                    upload_id,
                    body.get("database"),
                    actor,
                    organization_id,
                )
                self._json(201, restored)
            elif path.startswith("/v1/databases/") and path.endswith("/ddl"):
                encoded_name = path.removeprefix("/v1/databases/").removesuffix("/ddl")
                if "/" in encoded_name:
                    raise ApiError(404, "Route not found.")
                database = require_organization_database(organization_id, unquote(encoded_name))
                res = execute_ddl(database, body, actor, organization_id)
                self._json(200, res)
            elif path.startswith("/v1/activity/queries/") and path.endswith("/terminate"):
                pid_str = path.removeprefix("/v1/activity/queries/").removesuffix("/terminate")
                if not pid_str.isdigit():
                    raise ApiError(400, "Invalid process ID.")
                signal = str(body.get("action", "cancel"))
                res = terminate_query(
                    int(pid_str),
                    organization_id,
                    signal=signal,
                    actor=actor,
                )
                self._json(200, res)
            else:
                self._json(404, {"error": "Route not found."})
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except StopIteration:
            self._json(201, {"created": True})
        except (OSError, subprocess.SubprocessError):
            self._json(503, {"error": "Nanogres could not complete the operation."})

    def do_PUT(self) -> None:
        if not self._authorized():
            return
        try:
            organization_id = self._organization()
            if organization_id is None:
                return
            path = urlsplit(self.path).path
            match = re.fullmatch(
                r"/v1/restore-uploads/([a-f0-9]{32})/chunks/([0-9]+)", path
            )
            if not match:
                raise ApiError(404, "Route not found.")
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
                raise ApiError(415, "Content-Type must be application/octet-stream.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as error:
                raise ApiError(400, "Invalid upload chunk.") from error
            if length <= 0 or length > TRANSFER_CHUNK_BYTES:
                raise ApiError(413, "Upload chunk is too large.")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ApiError(400, "Upload chunk was incomplete.")
            result = store_restore_chunk(
                match.group(1),
                int(match.group(2)),
                body,
                organization_id,
            )
            self._json(200, {"chunk": result})
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except (OSError, subprocess.SubprocessError):
            self._json(503, {"error": "Nanogres could not store the upload chunk."})

    def do_DELETE(self) -> None:
        if not self._authorized():
            return
        try:
            organization_id = self._organization()
            if organization_id is None:
                return
            path = urlsplit(self.path).path
            transfer_match = re.fullmatch(r"/v1/transfers/([a-f0-9]{32})", path)
            if transfer_match:
                self._json(200, {"transfer": cancel_transfer_job(transfer_match.group(1), organization_id)})
                return
            upload_prefix = "/v1/restore-uploads/"
            if path.startswith(upload_prefix):
                upload_id = path.removeprefix(upload_prefix)
                upload_path, _metadata = read_restore_upload(upload_id, organization_id)
                shutil.rmtree(upload_path)
                self._json(200, {"deleted": True})
                return
            prefix = "/v1/databases/"
            if not path.startswith(prefix):
                self._json(404, {"error": "Route not found."})
                return
            logical_name = unquote(path.removeprefix(prefix))
            name = require_organization_database(organization_id, logical_name)
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
                clear_database_quota_setting(name)
                request_quota_reconcile()
            record_event(
                "database.deleted", f"Database {logical_name} deleted.", self._actor(), organization_id
            )
            self._json(200, {"deleted": True, "name": logical_name})
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except (OSError, subprocess.SubprocessError):
            self._json(503, {"error": "Nanogres could not complete the operation."})

    def _create_role(
        self,
        body: dict[str, object],
        actor: str | None,
        organization_id: object,
    ) -> None:
        logical_name = str(body.get("name", ""))
        name = tenant_resource_name(organization_id, logical_name, "Role name")
        logical_database = str(body.get("database", ""))
        database = require_organization_database(organization_id, logical_database)
        password = body.get("password")
        access = body.get("access")
        if (
            not isinstance(password, str)
            or not 16 <= len(password) <= 256
            or any(ord(character) < 32 or ord(character) == 127 for character in password)
        ):
            raise ApiError(400, "Password must contain 16 to 256 printable characters.")
        if access not in {"readwrite", "readonly"}:
            raise ApiError(400, "Choose readwrite or readonly access.")
        if logical_name in {"postgres", "nanogres_api", "nanogres_internal_query"}:
            raise ApiError(400, "That role name is reserved.")
        if run_sql(
            f"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {quote_literal(name)})",
            database,
        ) == "t":
            raise ApiError(409, "A role with that name already exists.")
        query_role = ensure_organization_query_role(organization_id)
        table_privileges = "SELECT, INSERT, UPDATE, DELETE" if access == "readwrite" else "SELECT"
        statements = [
            "BEGIN",
            "SET LOCAL password_encryption = 'scram-sha-256'",
            f"CREATE ROLE {quote_identifier(name)} LOGIN PASSWORD {quote_literal(password)}",
            f"GRANT CONNECT ON DATABASE {quote_identifier(database)} TO {quote_identifier(name)}",
            f"GRANT USAGE ON SCHEMA public TO {quote_identifier(name)}",
            f"GRANT {table_privileges} ON ALL TABLES IN SCHEMA public TO {quote_identifier(name)}",
            f"ALTER DEFAULT PRIVILEGES FOR ROLE {quote_identifier(query_role)} IN SCHEMA public GRANT {table_privileges} ON TABLES TO {quote_identifier(name)}",
        ]
        if access == "readwrite":
            statements.extend(
                [
                    f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO {quote_identifier(name)}",
                    f"ALTER DEFAULT PRIVILEGES FOR ROLE {quote_identifier(query_role)} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {quote_identifier(name)}",
                ]
            )
        statements.append("COMMIT")
        run_sql("; ".join(statements), database)
        record_event(
            "role.created",
            f"Role {logical_name} created for {logical_database} ({access}).",
            actor,
            organization_id,
        )
        self._json(
            201,
            {
                "role": {
                    "name": logical_name,
                    "loginName": name,
                    "database": logical_database,
                    "connectionDatabase": database,
                    "access": access,
                }
            },
        )

    def _download_backup(
        self,
        organization_id: object,
        encoded_name: str,
        query: dict[str, list[str]],
    ) -> None:
        filename = unquote(encoded_name)
        match = BACKUP_PATTERN.fullmatch(filename)
        if not match:
            raise ApiError(404, "Backup not found.")
        tenant_resource_name(organization_id, match.group(1), "Backup database name")
        path = organization_backup_dir(organization_id) / filename
        if not path.is_file() or path.is_symlink():
            raise ApiError(404, "Backup not found.")
        if (
            set(query) - {"offset", "length"}
            or len(query.get("offset", [])) != 1
            or len(query.get("length", [])) != 1
        ):
            raise ApiError(400, "Specify one download offset and length.")
        try:
            offset = int(query["offset"][0])
            length = int(query["length"][0])
        except ValueError as error:
            raise ApiError(400, "Download offset and length must be whole numbers.") from error
        total_size = path.stat().st_size
        if offset < 0 or offset >= total_size or length <= 0 or length > TRANSFER_CHUNK_BYTES:
            raise ApiError(416, "Download range is invalid.")
        chunk_size = min(length, total_size - offset)
        self.send_response(206)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(chunk_size))
        self.send_header("Content-Range", f"bytes {offset}-{offset + chunk_size - 1}/{total_size}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(offset)
            remaining = chunk_size
            while remaining:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def legacy_organization_migration_plan(organization_id: object) -> dict[str, object]:
    org_id = normalized_organization_id(organization_id)
    prefix = organization_prefix(org_id)
    existing_databases = {
        str(row.get("name")) for row in list_databases() if isinstance(row, dict)
    }
    databases: list[tuple[str, str]] = []
    for row in list_databases():
        old_name = row.get("name")
        if not isinstance(old_name, str) or row.get("systemDatabase"):
            continue
        if old_name.startswith(prefix):
            logical_name = old_name[len(prefix):]
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

    backup_sources: list[Path] = []
    for directory in (BACKUP_DIR, BACKUP_DIR / "legacy"):
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

    destination_dir = organization_backup_dir(org_id)
    if destination_dir.exists() and destination_dir.is_symlink():
        raise ApiError(409, "The organization backup directory is not a regular directory.")
    for path in backup_sources:
        if (destination_dir / path.name).exists():
            raise ApiError(409, f"The organization backup {path.name!r} already exists.")

    old_policy = read_quota_policy()
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

    if EVENTS_FILE.exists():
        try:
            for line in EVENTS_FILE.read_text(encoding="utf-8").splitlines():
                if line:
                    json.loads(line)
        except (OSError, json.JSONDecodeError) as error:
            raise ApiError(503, "The activity log is invalid and cannot be migrated safely.") from error

    return {
        "organizationId": org_id,
        "prefix": prefix,
        "databases": databases,
        "roles": roles,
        "backups": backup_sources,
        "quotaPolicy": policy,
    }


def migrate_legacy_organization(organization_id: object) -> dict[str, int]:
    plan = legacy_organization_migration_plan(organization_id)
    org_id = str(plan["organizationId"])
    prefix = str(plan["prefix"])
    role_name = organization_query_role(org_id)
    databases = plan["databases"]
    roles = plan["roles"]
    backups = plan["backups"]
    policy = plan["quotaPolicy"]
    assert isinstance(databases, list)
    assert isinstance(roles, list)
    assert isinstance(backups, list)
    assert isinstance(policy, dict)

    role_exists = run_sql(
        f"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {quote_literal(role_name)})"
    )
    if role_exists != "t":
        run_sql(
            f"CREATE ROLE {quote_identifier(role_name)} WITH NOLOGIN NOSUPERUSER "
            "NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
        )

    for old_name, new_name in roles:
        run_sql(
            f"ALTER ROLE {quote_identifier(old_name)} RENAME TO {quote_identifier(new_name)}"
        )

    for old_name, new_name in databases:
        if old_name != new_name:
            run_sql(
                f"ALTER DATABASE {quote_identifier(old_name)} RENAME TO {quote_identifier(new_name)}"
            )
        run_sql(
            f"ALTER DATABASE {quote_identifier(new_name)} OWNER TO {quote_identifier(role_name)}"
        )
        secure_organization_database(new_name, role_name)
        transfer_database_objects(new_name, role_name)

    destination_dir = organization_backup_dir(org_id)
    destination_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    for source in backups:
        source.replace(destination_dir / source.name)
    legacy_dir = BACKUP_DIR / "legacy"
    if legacy_dir.exists() and not any(legacy_dir.iterdir()):
        legacy_dir.rmdir()

    write_quota_policy(policy)
    try:
        QUOTA_REQUEST_FILE.touch(mode=0o600, exist_ok=True)
    except OSError:
        pass

    if EVENTS_FILE.exists():
        events = [
            json.loads(line)
            for line in EVENTS_FILE.read_text(encoding="utf-8").splitlines()
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
        fd, temporary = tempfile.mkstemp(prefix=".events.", dir=STATE_DIR)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                for event in migrated:
                    handle.write(json.dumps(event, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, EVENTS_FILE)
        finally:
            Path(temporary).unlink(missing_ok=True)

    return {
        "databases": len(databases),
        "roles": len(roles),
        "backups": len(backups),
    }


def main() -> int:
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
