"""Database storage quota policy/reconciliation and offsite backup freshness checks."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config as _config
from . import pg as _pg
from . import tenants as _tenants
from .config import ApiError, NAME_PATTERN, quota_policy_lock
from .pg import quote_literal


def quota_growth_bytes(requested_max_bytes: int, used_bytes: int) -> int:
    """Compute KiB-aligned additional growth room reserved for a custom quota."""
    requested_kib = (requested_max_bytes + 1023) // 1024
    used_kib = used_bytes // 1024
    return max(0, requested_kib - used_kib) * 1024


def read_status_file(path: Path) -> dict[str, object]:
    """Read a JSON status file, returning an empty dict if missing or malformed."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def read_quota_policy() -> dict[str, int]:
    """Load and validate custom database quota overrides from disk."""
    try:
        data = json.loads(_config.cfg("QUOTA_POLICY_FILE").read_text(encoding="utf-8"))
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
    """Atomically persist custom database quota overrides."""
    _config.cfg("STATE_DIR").mkdir(mode=0o700, parents=True, exist_ok=True)
    content = (
        json.dumps(
            {
                "version": 1,
                "databases": {
                    name: {"mode": "custom", "maxBytes": max_bytes}
                    for name, max_bytes in sorted(policy.items())
                },
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    _config.atomic_write_text(
        _config.cfg("QUOTA_POLICY_FILE"),
        content,
        prefix=".database-quota-policy.",
        fsync=True,
    )


def clear_database_quota_setting(database: str) -> None:
    """Remove any custom quota setting for `database` if present."""
    policy = _config.resolve("read_quota_policy", read_quota_policy)()
    if database in policy:
        policy.pop(database)
        _config.resolve("write_quota_policy", write_quota_policy)(policy)


def add_database_growth_targets(
    databases: list[dict[str, object]], free_bytes: int
) -> list[dict[str, object]]:
    """Annotate database listings with quota limits, headroom, and enforcement state."""
    growth_percent = _config.cfg("DATABASE_GROWTH_PERCENT")
    reserve_bytes = _config.cfg("DATABASE_QUOTA_RESERVE_BYTES")
    if not 1 <= growth_percent <= 50:
        raise ApiError(503, "Database growth percentage must be between 1 and 50.")

    user_databases = [database for database in databases if not database.get("systemDatabase")]
    growth_budget = max(0, free_bytes - reserve_bytes) * growth_percent // 100
    policy = _config.resolve("read_quota_policy", read_quota_policy)()
    quota_state = _config.resolve("read_status_file", read_status_file)(
        _config.cfg("QUOTA_STATUS_FILE")
    )
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
    growth_fn = _config.resolve("quota_growth_bytes", quota_growth_bytes)
    custom_growth_by_name = {
        name: growth_fn(requested_bytes, used_by_name.get(name, 0))
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
        headroom = (
            0
            if system_database
            else (
                max(0, requested_max_bytes - used_by_name.get(name, size_bytes))
                if requested_max_bytes is not None
                else per_database_headroom
            )
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
            custom_headroom
            for other_name, custom_headroom in custom_growth_by_name.items()
            if other_name != name
        )
        maximum_custom_growth = max(0, growth_budget - other_custom_growth) // 1024 * 1024
        database["maximumCustomMaxBytes"] = (
            used_bytes + maximum_custom_growth if not system_database else 0
        )
        database["quotaConstrained"] = (
            bool(quota.get("quotaConstrained", False)) if isinstance(quota, dict) else False
        )
        if enforced and isinstance(quota, dict):
            quota_used = max(0, int(quota.get("usedBytes", size_bytes)))
            hard_limit = max(quota_used, int(quota.get("hardLimitBytes", quota_used)))
            database["quotaUsedBytes"] = quota_used
            database["growthHeadroomBytes"] = max(0, hard_limit - quota_used)
            database["recommendedMaxBytes"] = hard_limit
            database["quotaConstrained"] = bool(quota.get("quotaConstrained", False))
    return databases


def parse_status_timestamp(value: object) -> datetime | None:
    """Parse an ISO-8601 status timestamp normalized to UTC."""
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
    """Compute offsite backup freshness and error status from saved state."""
    now = now or datetime.now(timezone.utc)
    parse_ts = _config.resolve("parse_status_timestamp", parse_status_timestamp)
    last_attempt = parse_ts(saved.get("lastAttemptAt"))
    last_success = parse_ts(saved.get("lastSuccessAt"))
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
    elif age_seconds is not None and age_seconds > _config.cfg("OFFSITE_BACKUP_MAX_AGE").total_seconds():
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
    """Read offsite backup state and calculate freshness status."""
    saved = _config.resolve("read_status_file", read_status_file)(
        _config.cfg("OFFSITE_STATUS_FILE")
    )
    env_file = _config.cfg("OFFSITE_ENV_FILE")
    configured = env_file.is_file() and env_file.stat().st_size > 0
    return _config.resolve("calculate_offsite_backup_status", calculate_offsite_backup_status)(
        saved, configured
    )


def request_quota_reconcile(
    database: str | None = None,
    expected_mode: str | None = None,
    expected_max_bytes: int | None = None,
) -> None:
    """Trigger the systemd quota reconciler and wait for enforcement verification when active."""
    quota_status_file = _config.cfg("QUOTA_STATUS_FILE")
    quota_request_file = _config.cfg("QUOTA_REQUEST_FILE")
    read_status = _config.resolve("read_status_file", read_status_file)
    previous = read_status(quota_status_file)
    try:
        quota_request_file.touch(mode=0o600, exist_ok=True)
        if not (previous.get("filesystemEnabled") is True or previous.get("enabled") is True) or not database:
            return
        identifier = _config.resolve("run_sql", _pg.run_sql)(
            f"SELECT oid FROM pg_database WHERE datname = {quote_literal(database)}"
        )
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            state = read_status(quota_status_file)
            quotas = state.get("databases", {})
            if (
                state.get("enabled") is True
                and isinstance(quotas, dict)
                and isinstance(quotas.get(identifier), dict)
                and quotas[identifier].get("hardLimitEnforced") is True
            ):
                quota = quotas[identifier]
                if (expected_mode is None or quota.get("quotaMode") == expected_mode) and (
                    expected_max_bytes is None
                    or quota.get("requestedMaxBytes") == expected_max_bytes
                ):
                    return
            time.sleep(0.25)
        raise ApiError(503, "The database storage limit could not be verified. Try again shortly.")
    except OSError:
        if previous.get("filesystemEnabled") is True or previous.get("enabled") is True:
            raise ApiError(503, "The database storage limit could not be verified. Try again shortly.")


def request_offsite_backup() -> None:
    """Request an immediate offsite backup sync if offsite storage is configured."""
    env_file = _config.cfg("OFFSITE_ENV_FILE")
    if not env_file.is_file() or env_file.stat().st_size == 0:
        return
    try:
        _config.cfg("OFFSITE_REQUEST_FILE").touch(mode=0o600, exist_ok=True)
    except OSError:
        # The local backup is still available; the offsite status remains explicit.
        return


def update_database_quota(
    organization_id: object,
    name_value: object,
    body: dict[str, object],
    actor: str | None,
) -> dict[str, object]:
    """Update a database's storage quota mode (`auto` or `custom`) and verify enforcement."""
    logical_name = str(name_value) if isinstance(name_value, str) else ""
    name = _config.resolve("organization_database_name", _tenants.organization_database_name)(
        organization_id, logical_name
    )

    mode = body.get("mode")
    if mode != "auto" and mode != "custom":
        raise ApiError(400, "Choose automatic or custom database sizing.")
    requested_max_bytes: int | None = None
    if mode == "custom":
        value = body.get("maxBytes")
        if type(value) is not int or value <= 0:
            raise ApiError(400, "Enter a valid maximum database size in bytes.")
        requested_max_bytes = value

    read_policy = _config.resolve("read_quota_policy", read_quota_policy)
    write_policy = _config.resolve("write_quota_policy", write_quota_policy)
    pg_status_fn = _config.resolve("postgres_status", _pg.postgres_status)
    read_status = _config.resolve("read_status_file", read_status_file)
    list_dbs = _config.resolve("list_databases", _tenants.list_databases)
    growth_fn = _config.resolve("quota_growth_bytes", quota_growth_bytes)
    reconcile = _config.resolve("request_quota_reconcile", request_quota_reconcile)
    reserve_bytes = _config.cfg("DATABASE_QUOTA_RESERVE_BYTES")
    growth_percent = _config.cfg("DATABASE_GROWTH_PERCENT")

    with quota_policy_lock:
        old_policy = read_policy()
        status = pg_status_fn()
        quota_state = read_status(_config.cfg("QUOTA_STATUS_FILE"))
        quota_databases = quota_state.get("databases", {})
        if not isinstance(quota_databases, dict) or quota_state.get("enabled") is not True:
            raise ApiError(503, "Per-database hard quotas are not currently available.")

        rows = list_dbs()
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
            max(0, int(status["disk"]["freeBytes"]) - reserve_bytes) * growth_percent // 100
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
            other_custom_growth_kib += growth_fn(other_max_bytes, other_used) // 1024

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

        write_policy(new_policy)
        try:
            reconcile(
                name,
                expected_mode=str(mode),
                expected_max_bytes=requested_max_bytes,
            )
        except ApiError:
            write_policy(old_policy)
            try:
                _config.cfg("QUOTA_REQUEST_FILE").touch(mode=0o600, exist_ok=True)
            except OSError:
                pass
            raise

    description = (
        f"Database {logical_name} quota returned to Auto."
        if mode == "auto"
        else f"Database {logical_name} custom maximum set to {requested_max_bytes} bytes."
    )
    _config.resolve("record_event", _tenants.record_event)(
        "database.quota.updated", description, actor, organization_id
    )
    refreshed_status = pg_status_fn()
    databases = _config.resolve("add_database_growth_targets", add_database_growth_targets)(
        list_dbs(), int(refreshed_status["disk"]["freeBytes"])
    )
    scoped_databases = _config.resolve(
        "public_tenant_databases", _tenants.public_tenant_databases
    )(organization_id, databases)
    return next(item for item in scoped_databases if item["name"] == logical_name)
