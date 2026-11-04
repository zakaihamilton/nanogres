#!/usr/bin/env python3
"""Small, private HTTP control API for the Nanogres Postgres host."""

from __future__ import annotations

import hmac
import json
import os
import re
import shutil
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
BACKUP_PATTERN = re.compile(r"^([a-z][a-z0-9_]*)__([0-9]{8}T[0-9]{12}Z)\.dump$")
UPLOAD_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
ACTOR_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
RESTORE_UPLOAD_TTL = timedelta(hours=24)
RESTORE_UPLOAD_DIR = STATE_DIR / "restore-uploads"
RESTORE_UPLOAD_DISK_RESERVE_BYTES = 512 * 1024 * 1024
QUOTA_STATUS_FILE = STATE_DIR / "database-quotas.json"
QUOTA_POLICY_FILE = STATE_DIR / "database-quota-policy.json"
OFFSITE_STATUS_FILE = STATE_DIR / "offsite-backup-status.json"
OFFSITE_ENV_FILE = Path("/etc/nanogres/backup.env")
OFFSITE_BACKUP_MAX_AGE = timedelta(hours=36)
QUOTA_REQUEST_FILE = STATE_DIR / "quota-reconcile.request"
OFFSITE_REQUEST_FILE = STATE_DIR / "offsite-backup.request"
event_lock = threading.Lock()
backup_lock = threading.Lock()
quota_policy_lock = threading.Lock()


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


def quota_growth_bytes(requested_max_bytes: int, used_bytes: int) -> int:
    requested_kib = (requested_max_bytes + 1023) // 1024
    used_kib = used_bytes // 1024
    return max(0, requested_kib - used_kib) * 1024


def run_sql(statement: str, database: str = "postgres") -> str:
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
    env = pg_client_env("5")
    result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=20)
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


def list_roles() -> list[dict[str, object]]:
    rows = json_query(
        """
        SELECT COALESCE(json_agg(row_to_json(items) ORDER BY items.name), '[]'::json)::text
        FROM (
          SELECT rolname AS name,
                 rolsuper AS superuser,
                 rolcreatedb AS "canCreateDatabase",
                 rolcreaterole AS "canCreateRole",
                 rolvaliduntil AS "validUntil",
                 rolname = 'postgres' AS "systemRole"
          FROM pg_roles
          WHERE rolcanlogin AND rolname !~ '^pg_'
        ) items
        """
    )
    return rows if isinstance(rows, list) else []


def list_backups() -> list[dict[str, object]]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, object]] = []
    for path in BACKUP_DIR.iterdir():
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


def list_activity(limit: int = 50) -> list[dict[str, object]]:
    if not EVENTS_FILE.exists():
        return []
    try:
        lines = EVENTS_FILE.read_text(encoding="utf-8").splitlines()[-limit:]
        return [json.loads(line) for line in reversed(lines) if line]
    except (OSError, json.JSONDecodeError):
        return []


def record_event(action: str, detail: str, actor: str | None = None) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    event = {
        "action": action,
        "detail": detail,
        "actor": actor if actor and ACTOR_PATTERN.fullmatch(actor) else None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    with event_lock:
        with EVENTS_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        os.chmod(EVENTS_FILE, 0o600)


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
    for path in BACKUP_DIR.iterdir():
        if not BACKUP_PATTERN.fullmatch(path.name) or path.is_symlink() or not path.is_file():
            continue
        if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < cutoff:
            path.unlink()
            removed += 1
    return removed


def create_backup(
    database: str,
    actor: str | None = None,
    timeout_seconds: int = 3600,
    upload_offsite: bool = True,
) -> dict[str, object]:
    if not NAME_PATTERN.fullmatch(database) or database == "postgres":
        raise ApiError(400, "Choose a user database to back up.")
    exists = run_sql(
        f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(database)})"
    )
    if exists != "t":
        raise ApiError(404, "Database not found.")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"{database}__{timestamp}.dump"
    final_path = BACKUP_DIR / filename
    partial_path = BACKUP_DIR / f".{filename}.partial"
    command = [
        pg_client("pg_dump"),
        "--format=custom",
        "--no-owner",
        "--file",
        str(partial_path),
        "--dbname",
        database,
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
    record_event("backup.created", f"Backup created for {database}.", actor)
    if upload_offsite:
        request_offsite_backup()
    return {
        "filename": filename,
        "database": database,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sizeBytes": final_path.stat().st_size,
    }


def restore_backup(encoded_name: str, target: object, actor: str | None = None) -> dict[str, object]:
    filename = unquote(encoded_name)
    match = BACKUP_PATTERN.fullmatch(filename)
    if not match:
        raise ApiError(404, "Backup not found.")
    target_name = valid_name(target, "New database name")
    if target_name in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Choose a new user database name.")

    backup_path = BACKUP_DIR / filename
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
                f"CREATE DATABASE {quote_identifier(target_name)} OWNER postgres ENCODING 'UTF8' TEMPLATE template0"
            )
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
        env = pg_client_env("10")
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

    record_event(
        "backup.restored",
        f"Backup {filename} restored as new database {target_name}.",
        actor,
    )
    return {"database": target_name, "restoredFrom": filename}


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


def read_restore_upload(upload_id: str) -> tuple[Path, dict[str, int]]:
    path = restore_upload_path(upload_id)
    try:
        metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(404, "Restore upload not found.") from error
    size_bytes = metadata.get("sizeBytes") if isinstance(metadata, dict) else None
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        raise ApiError(400, "Restore upload metadata is invalid.")
    chunk_count = (size_bytes + TRANSFER_CHUNK_BYTES - 1) // TRANSFER_CHUNK_BYTES
    return path, {"sizeBytes": size_bytes, "chunkCount": chunk_count}


def create_restore_upload(body: dict[str, object]) -> dict[str, object]:
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
    metadata_path.write_text(json.dumps({"sizeBytes": size_bytes}), encoding="utf-8")
    os.chmod(metadata_path, 0o600)
    return {
        "uploadId": upload_id,
        "chunkSizeBytes": TRANSFER_CHUNK_BYTES,
        "chunkCount": (size_bytes + TRANSFER_CHUNK_BYTES - 1) // TRANSFER_CHUNK_BYTES,
    }


def store_restore_chunk(upload_id: str, chunk_index: int, body: bytes) -> dict[str, int]:
    upload_path, metadata = read_restore_upload(upload_id)
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
    command: list[str], upload_path: Path, chunk_count: int, timeout_seconds: int
) -> int | None:
    env = pg_client_env("10")
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
    upload_id: str, target: object, actor: str | None = None
) -> dict[str, object]:
    upload_path, metadata = read_restore_upload(upload_id)
    target_name = valid_name(target, "New database name")
    if target_name in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Choose a new user database name.")

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
                f"CREATE DATABASE {quote_identifier(target_name)} OWNER postgres ENCODING 'UTF8' TEMPLATE template0"
            )
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

    shutil.rmtree(upload_path)
    record_event(
        "backup.restored",
        f"Uploaded PostgreSQL dump restored as new database {target_name}.",
        actor,
    )
    return {"database": target_name, "restoredFrom": "uploaded file"}


def backup_all() -> int:
    cleanup_old_restore_uploads()
    databases = [row["name"] for row in list_databases() if row.get("name") != "postgres"]
    completed = 0
    for database in databases:
        create_backup(str(database), upload_offsite=False)
        completed += 1
    cleanup_old_backups()
    return completed


def valid_name(value: object, label: str) -> str:
    if not isinstance(value, str) or not NAME_PATTERN.fullmatch(value):
        raise ApiError(400, f"{label} must start with a lowercase letter and contain only lowercase letters, numbers, or underscores.")
    return value


def update_database_quota(
    name_value: object, body: dict[str, object], actor: str | None
) -> dict[str, object]:
    name = valid_name(name_value, "Database name")
    if name in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Choose a user database to change its quota.")

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
        f"Database {name} quota returned to Auto."
        if mode == "auto"
        else f"Database {name} custom maximum set to {requested_max_bytes} bytes."
    )
    record_event("database.quota.updated", description, actor)
    refreshed_status = postgres_status()
    databases = add_database_growth_targets(
        list_databases(), int(refreshed_status["disk"]["freeBytes"])
    )
    return next(item for item in databases if item["name"] == name)


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

    def _body(self) -> dict[str, object]:
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ApiError(415, "Content-Type must be application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ApiError(400, "Invalid request body.") from error
        if length <= 0 or length > 8192:
            raise ApiError(413, "Request body must be between 1 and 8192 bytes.")
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
            elif path == "/v1/overview":
                status = postgres_status()
                databases = add_database_growth_targets(
                    list_databases(), int(status["disk"]["freeBytes"])
                )
                self._json(
                    200,
                    {
                        "status": status,
                        "databases": databases,
                        "backups": list_backups()[:8],
                        "activity": list_activity(8),
                    },
                )
            elif path == "/v1/databases":
                status = postgres_status()
                databases = add_database_growth_targets(
                    list_databases(), int(status["disk"]["freeBytes"])
                )
                self._json(200, {"status": status, "databases": databases})
            elif path == "/v1/roles":
                self._json(200, {"roles": list_roles()})
            elif path == "/v1/backups":
                self._json(200, {"backups": list_backups()})
            elif path == "/v1/activity":
                self._json(200, {"events": list_activity()})
            elif path.startswith("/v1/backups/"):
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                self._download_backup(path.removeprefix("/v1/backups/"), query)
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
            body = self._body()
            actor = self._actor()
            if path == "/v1/databases":
                name = valid_name(body.get("name"), "Database name")
                with quota_policy_lock:
                    exists = run_sql(
                        f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(name)})"
                    )
                    if exists == "t":
                        raise ApiError(409, "A database with that name already exists.")
                    clear_database_quota_setting(name)
                    run_sql(
                        f"CREATE DATABASE {quote_identifier(name)} OWNER postgres ENCODING 'UTF8' TEMPLATE template0"
                    )
                    try:
                        request_quota_reconcile(name)
                    except ApiError:
                        run_sql(f"DROP DATABASE {quote_identifier(name)}")
                        raise
                record_event("database.created", f"Database {name} created.", actor)
                status = postgres_status()
                databases = add_database_growth_targets(
                    list_databases(), int(status["disk"]["freeBytes"])
                )
                self._json(201, {"database": next(row for row in databases if row["name"] == name)})
            elif path.startswith("/v1/databases/") and path.endswith("/quota"):
                encoded_name = path.removeprefix("/v1/databases/").removesuffix("/quota")
                if "/" in encoded_name:
                    raise ApiError(404, "Route not found.")
                database = update_database_quota(unquote(encoded_name), body, actor)
                self._json(200, {"database": database})
            elif path == "/v1/roles":
                self._create_role(body, actor)
            elif path == "/v1/backups":
                database = valid_name(body.get("database"), "Database name")
                with backup_lock:
                    backup = create_backup(database, actor, timeout_seconds=240)
                self._json(201, {"backup": backup})
            elif path.startswith("/v1/backups/") and path.endswith("/restore"):
                encoded_name = path.removeprefix("/v1/backups/").removesuffix("/restore")
                restored = restore_backup(encoded_name, body.get("database"), actor)
                self._json(201, restored)
            elif path == "/v1/restore-uploads":
                self._json(201, create_restore_upload(body))
            elif path.startswith("/v1/restore-uploads/") and path.endswith("/complete"):
                upload_id = path.removeprefix("/v1/restore-uploads/").removesuffix("/complete")
                restored = restore_uploaded_dump(upload_id, body.get("database"), actor)
                self._json(201, restored)
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
            result = store_restore_chunk(match.group(1), int(match.group(2)), body)
            self._json(200, {"chunk": result})
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except (OSError, subprocess.SubprocessError):
            self._json(503, {"error": "Nanogres could not store the upload chunk."})

    def do_DELETE(self) -> None:
        if not self._authorized():
            return
        try:
            path = urlsplit(self.path).path
            upload_prefix = "/v1/restore-uploads/"
            if path.startswith(upload_prefix):
                upload_id = path.removeprefix(upload_prefix)
                upload_path = restore_upload_path(upload_id)
                shutil.rmtree(upload_path)
                self._json(200, {"deleted": True})
                return
            prefix = "/v1/databases/"
            if not path.startswith(prefix):
                self._json(404, {"error": "Route not found."})
                return
            name = valid_name(unquote(path.removeprefix(prefix)), "Database name")
            if name in {"postgres", "template0", "template1"}:
                raise ApiError(400, "A default PostgreSQL database cannot be removed.")
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
            record_event("database.deleted", f"Database {name} deleted.", self._actor())
            self._json(200, {"deleted": True, "name": name})
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except (OSError, subprocess.SubprocessError):
            self._json(503, {"error": "Nanogres could not complete the operation."})

    def _create_role(self, body: dict[str, object], actor: str | None) -> None:
        name = valid_name(body.get("name"), "Role name")
        database = valid_name(body.get("database"), "Database name")
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
        if name in {"postgres", "nanogres_api"}:
            raise ApiError(400, "That role name is reserved.")
        if run_sql(
            f"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {quote_literal(name)})",
            database,
        ) == "t":
            raise ApiError(409, "A role with that name already exists.")
        table_privileges = "SELECT, INSERT, UPDATE, DELETE" if access == "readwrite" else "SELECT"
        statements = [
            "BEGIN",
            "SET LOCAL password_encryption = 'scram-sha-256'",
            f"CREATE ROLE {quote_identifier(name)} LOGIN PASSWORD {quote_literal(password)}",
            f"GRANT CONNECT ON DATABASE {quote_identifier(database)} TO {quote_identifier(name)}",
            f"GRANT USAGE ON SCHEMA public TO {quote_identifier(name)}",
            f"GRANT {table_privileges} ON ALL TABLES IN SCHEMA public TO {quote_identifier(name)}",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT {table_privileges} ON TABLES TO {quote_identifier(name)}",
        ]
        if access == "readwrite":
            statements.extend(
                [
                    f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO {quote_identifier(name)}",
                    f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {quote_identifier(name)}",
                ]
            )
        statements.append("COMMIT")
        run_sql("; ".join(statements), database)
        record_event("role.created", f"Role {name} created for {database} ({access}).", actor)
        self._json(201, {"role": {"name": name, "database": database, "access": access}})

    def _download_backup(self, encoded_name: str, query: dict[str, list[str]]) -> None:
        filename = unquote(encoded_name)
        if not BACKUP_PATTERN.fullmatch(filename):
            raise ApiError(404, "Backup not found.")
        path = BACKUP_DIR / filename
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


def main() -> int:
    if "--backup-all" in sys.argv:
        with backup_lock:
            print(f"Created {backup_all()} Nanogres backup(s).")
        return 0
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
