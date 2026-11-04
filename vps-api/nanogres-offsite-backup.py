#!/usr/bin/env python3
"""Copy retained local PostgreSQL backups to a private S3-compatible bucket."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


BACKUP_DIR = Path(os.environ.get("NANOGRES_BACKUP_DIR", "/var/backups/nanogres"))
STATE_DIR = Path(os.environ.get("NANOGRES_STATE_DIR", "/var/lib/nanogres"))
STATUS_FILE = STATE_DIR / "offsite-backup-status.json"
REMOTE = os.environ.get("NANOGRES_S3_REMOTE", "spaces:nanogres-backups/nanogres")
PATTERN = re.compile(r"^[a-z][a-z0-9_]*__[0-9]{8}T[0-9]{12}Z\.dump$")


def write_status(value: dict[str, object]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".offsite-backup-status.", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, STATUS_FILE)
    finally:
        Path(temporary).unlink(missing_ok=True)


def upload() -> None:
    (STATE_DIR / "offsite-backup.request").unlink(missing_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    backups = [
        path for path in BACKUP_DIR.rglob("*.dump")
        if PATTERN.fullmatch(path.name) and path.is_file() and not path.is_symlink()
    ] if BACKUP_DIR.exists() else []
    base = {
        "configured": True,
        "lastAttemptAt": started,
        "lastSuccessAt": None,
        "backupCount": 0,
        "storedBytes": 0,
        "lastError": None,
    }
    try:
        if not os.environ.get("RCLONE_CONFIG_SPACES_ACCESS_KEY_ID") or not os.environ.get("RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY"):
            raise RuntimeError("The Spaces credentials are incomplete.")
        copy = subprocess.run(
            ["/usr/bin/rclone", "copy", str(BACKUP_DIR), REMOTE, "--include", "*.dump", "--no-traverse", "--checkers", "2", "--transfers", "1", "--retries", "3", "--low-level-retries", "10"],
            check=True,
            capture_output=True,
            text=True,
            timeout=6 * 60 * 60,
            env=os.environ.copy(),
        )
        del copy
        verify = subprocess.run(
            ["/usr/bin/rclone", "check", str(BACKUP_DIR), REMOTE, "--one-way", "--size-only", "--include", "*.dump", "--checkers", "2"],
            check=True,
            capture_output=True,
            text=True,
            timeout=6 * 60 * 60,
            env=os.environ.copy(),
        )
        del verify
        base.update(
            {
                "lastSuccessAt": datetime.now(timezone.utc).isoformat(),
                "backupCount": len(backups),
                "storedBytes": sum(path.stat().st_size for path in backups),
            }
        )
    except (OSError, subprocess.SubprocessError, RuntimeError):
        base["lastError"] = "Upload or remote size verification failed; inspect the offsite service log on the VPS."
        write_status(base)
        raise
    write_status(base)


if __name__ == "__main__":
    try:
        upload()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
