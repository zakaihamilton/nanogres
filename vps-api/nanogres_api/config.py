"""Configuration constants, validation patterns, shared locks, and compatibility helpers."""

from __future__ import annotations

import os
import re
import tempfile
import threading
from datetime import timedelta
from pathlib import Path
from typing import Any, TypeVar

T = TypeVar("T")

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
WORKLOAD_IDENTITY_DIR = STATE_DIR / "workload-identities"
TRANSFER_JOB_PATTERN = re.compile(r"^[a-f0-9]{32}$")
WORKLOAD_IDENTITY_PATTERN = re.compile(r"^[a-f0-9]{32}$")
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
workload_identity_lock = threading.RLock()
workload_ssh_key_lock = threading.RLock()


class ApiError(Exception):
    """HTTP-mapped error raised by Nanogres VPS control API operations."""

    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


_COMPAT_NAMESPACES: list[tuple[dict[str, object], dict[str, object]]] = []


def register_compat_namespace(namespace: dict[str, object]) -> None:
    """Register a facade module namespace so monkeypatches on `api` propagate across submodules."""
    for existing_ns, _ in _COMPAT_NAMESPACES:
        if existing_ns is namespace:
            return
    _COMPAT_NAMESPACES.append((namespace, dict(namespace)))


def resolve(name: str, default: T) -> T:
    """Return a symbol overridden on a registered facade namespace, or `default` otherwise."""
    for namespace, initial in reversed(_COMPAT_NAMESPACES):
        if name in namespace and (name not in initial or namespace[name] is not initial[name]):
            return namespace[name]  # type: ignore[return-value]
    return default


def cfg(name: str) -> Any:
    """Resolve a configuration constant, honoring patches on either `api` or `config`."""
    return resolve(name, globals()[name])


def atomic_write_text(
    path: Path,
    content: str,
    *,
    mode: int = 0o600,
    dir_mode: int = 0o700,
    prefix: str | None = None,
    fsync: bool = False,
) -> None:
    """Write text atomically into `path` with restrictive permissions."""
    path.parent.mkdir(mode=dir_mode, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=prefix or f".{path.name}.", dir=path.parent)
    try:
        try:
            os.fchmod(fd, mode)
        except Exception:
            os.close(fd)
            raise
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            if fsync:
                handle.flush()
                os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
