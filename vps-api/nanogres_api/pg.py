"""PostgreSQL CLI execution, identifier quoting, and server status queries."""

from __future__ import annotations

import json
import os
import shutil
import subprocess

from . import config as _config
from .config import ApiError, NAME_PATTERN


def pg_client(binary: str) -> str:
    """Return the full path to a PostgreSQL client binary."""
    return str(_config.cfg("PG_BIN_DIR") / binary)


def pg_client_env(timeout: str = "5") -> dict[str, str]:
    """Build a minimal environment dictionary for PostgreSQL client binaries."""
    pg_bin_dir = _config.cfg("PG_BIN_DIR")
    env = {
        "PATH": f"{pg_bin_dir}:/usr/bin:/bin",
        "LC_ALL": "C",
        "PGCONNECT_TIMEOUT": timeout,
    }
    for key in ("PGHOST", "PGPORT", "PGUSER", "PGSSLMODE"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def quote_identifier(value: str) -> str:
    """Safely double-quote a PostgreSQL identifier."""
    return '"' + value.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    """Safely single-quote a PostgreSQL SQL string literal."""
    return "'" + value.replace("'", "''") + "'"


def run_sql(
    statement: str,
    database: str = "postgres",
    env: dict[str, str] | None = None,
) -> str:
    """Execute a SQL statement via `psql` and return trimmed stdout."""
    if not NAME_PATTERN.fullmatch(database) and database not in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Invalid database name.")
    command = [
        _config.resolve("pg_client", pg_client)("psql"),
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
    environment = env if env is not None else _config.resolve("pg_client_env", pg_client_env)("5")
    result = subprocess.run(command, capture_output=True, text=True, env=environment, timeout=20)
    if result.returncode:
        # Do not return SQL text or PostgreSQL internals to callers.
        raise ApiError(400, "PostgreSQL rejected the operation.")
    return result.stdout.strip()


def json_query(statement: str, database: str = "postgres") -> object:
    """Execute a SQL query returning JSON and parse the decoded result."""
    output = _config.resolve("run_sql", run_sql)(statement, database)
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise ApiError(503, "PostgreSQL returned an invalid response.") from error


def postgres_status() -> dict[str, object]:
    """Collect PostgreSQL server, disk, quota, and offsite backup status."""
    from . import quotas_offsite as _quotas_offsite

    status = _config.resolve("json_query", json_query)(
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
    data_directory = _config.resolve("run_sql", run_sql)("SHOW data_directory")
    disk = shutil.disk_usage(data_directory)
    quota_state = _config.resolve("read_status_file", _quotas_offsite.read_status_file)(
        _config.cfg("QUOTA_STATUS_FILE")
    )
    return {
        **status,
        "disk": {"totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
        "backupRetentionDays": _config.cfg("BACKUP_RETENTION_DAYS"),
        "databaseGrowthPercent": _config.cfg("DATABASE_GROWTH_PERCENT"),
        "databaseQuotaReserveBytes": int(
            quota_state.get("reserveBytes", _config.cfg("DATABASE_QUOTA_RESERVE_BYTES"))
        ),
        "databaseQuotaEnforced": quota_state.get("enabled") is True,
        "databaseQuotaReason": quota_state.get("reason"),
        "databaseQuotaCheckedAt": quota_state.get("lastReconciledAt"),
        "offsiteBackup": _config.resolve(
            "offsite_backup_status", _quotas_offsite.offsite_backup_status
        )(),
    }
