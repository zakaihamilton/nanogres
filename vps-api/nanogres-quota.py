#!/usr/bin/env python3
"""Reconcile ext4 project quotas for PostgreSQL database directories."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


STATE_DIR = Path("/var/lib/nanogres")
STATUS_FILE = STATE_DIR / "database-quotas.json"
MANAGED_FILE = STATE_DIR / "quota-managed.json"
RESERVE_BYTES = int(os.environ.get("NANOGRES_DATABASE_QUOTA_RESERVE_BYTES", str(1024**3)))
API_ENV_FILE = Path("/etc/nanogres/api.env")
PG_ENV = {"PATH": "/usr/bin:/usr/sbin:/bin:/sbin", "LC_ALL": "C", "PGCONNECT_TIMEOUT": "5"}


class QuotaError(RuntimeError):
    pass


def growth_percent() -> int:
    try:
        for line in API_ENV_FILE.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() == "NANOGRES_DATABASE_GROWTH_PERCENT":
                return int(value.strip().strip("\"'"))
    except (OSError, ValueError):
        pass
    return 25


def run(command: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            env=PG_ENV,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise QuotaError("The filesystem quota tools could not complete reconciliation.") from error
    return result


def write_json(path: Path, value: dict[str, object], mode: int) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def mark_unavailable(reason: str) -> None:
    write_json(
        STATUS_FILE,
        {
            "enabled": False,
            "method": "ext4-project-quota",
            "reason": reason,
            "lastReconciledAt": datetime.now(timezone.utc).isoformat(),
            "databases": {},
        },
        0o644,
    )


def read_managed() -> dict[str, str]:
    try:
        data = json.loads(MANAGED_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def data_directory() -> Path:
    result = run(
        ["/usr/sbin/runuser", "-u", "postgres", "--", "/usr/bin/psql", "--no-psqlrc",
         "--no-align", "--tuples-only", "--quiet", "--set=ON_ERROR_STOP=1", "--dbname", "postgres",
         "--command", "SHOW data_directory"],
        timeout=20,
    )
    return Path(result.stdout.strip()).resolve(strict=True)


def database_rows() -> list[dict[str, object]]:
    query = """
      SELECT COALESCE(json_agg(row_to_json(items) ORDER BY items.name), '[]'::json)::text
      FROM (
        SELECT d.oid AS id,
               d.datname AS name,
               pg_database_size(d.oid) AS "sizeBytes",
               d.dattablespace = (SELECT oid FROM pg_tablespace WHERE spcname = 'pg_default') AS eligible
        FROM pg_database d
        WHERE d.datallowconn AND NOT d.datistemplate AND d.datname <> 'postgres'
      ) items
    """
    result = run(
        ["/usr/sbin/runuser", "-u", "postgres", "--", "/usr/bin/psql", "--no-psqlrc",
         "--no-align", "--tuples-only", "--quiet", "--set=ON_ERROR_STOP=1", "--dbname", "postgres",
         "--command", query],
        timeout=30,
    )
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise QuotaError("PostgreSQL returned invalid database metadata.") from error
    if not isinstance(rows, list):
        raise QuotaError("PostgreSQL returned invalid database metadata.")
    return rows


def quota_mount(data_path: Path) -> tuple[str, str, str]:
    result = run(["/usr/bin/findmnt", "--noheadings", "--output", "SOURCE,FSTYPE,OPTIONS", "--target", str(data_path)])
    fields = result.stdout.strip().split(None, 2)
    if len(fields) != 3:
        raise QuotaError("Could not identify the PostgreSQL data filesystem.")
    return fields[0], fields[1], fields[2]


def read_feature_set(device: str) -> set[str]:
    result = run(["/sbin/tune2fs", "-l", device])
    match = re.search(r"^Filesystem features:\s*(.+)$", result.stdout, re.MULTILINE)
    if not match:
        return set()
    return set(match.group(1).split())


def project_quota_records() -> dict[str, dict[str, int]]:
    result = run(["/usr/sbin/repquota", "-P", "-n", "-v", "-O", "xml", "/"])
    try:
        root = ET.fromstring(result.stdout)
    except ET.ParseError as error:
        raise QuotaError("The quota report could not be parsed.") from error

    projects: dict[str, dict[str, int]] = {}
    for entry in root.findall(".//Quota"):
        # quota-tools releases have used both the generic "user" attribute and
        # the project-specific "project" attribute for project rows.
        identifier = entry.attrib.get("project", entry.attrib.get("user", ""))
        match = re.fullmatch(r"#?(\d+)", identifier)
        limits = entry.find("blockLimits")
        if not match or limits is None:
            continue
        try:
            projects[match.group(1)] = {
                "usedKib": int(limits.attrib.get("used", "0")),
                "softKib": int(limits.attrib.get("soft", "0")),
                "hardKib": int(limits.attrib.get("hard", "0")),
            }
        except ValueError as error:
            raise QuotaError("The quota report contained invalid limits.") from error
    return projects


def assign_project_tree(project_id: int, directory: Path) -> None:
    run(["/usr/bin/chattr", "-R", "-p", str(project_id), str(directory)], timeout=600)
    run(["/usr/bin/chattr", "-p", str(project_id), "+P", str(directory)], timeout=30)


def reconcile() -> None:
    (STATE_DIR / "quota-reconcile.request").unlink(missing_ok=True)
    growth = growth_percent()
    if not 1 <= growth <= 50:
        mark_unavailable("The per-database growth percentage must be between 1 and 50.")
        return

    path = data_directory()
    device, filesystem, options = quota_mount(path)
    if filesystem != "ext4":
        mark_unavailable("The PostgreSQL data filesystem is not ext4 with project quotas enabled.")
        return
    features = read_feature_set(device)
    if "project" not in features or "quota" not in features or "prjquota" not in options.split(","):
        mark_unavailable("Project quotas are not enabled on PostgreSQL's data filesystem.")
        return

    # A successful project quota report is the runtime proof that kernel accounting is active.
    records = project_quota_records()
    databases = database_rows()
    managed = read_managed()
    active_ids = {str(int(row["id"])) for row in databases}
    for old_id in set(managed) - active_ids:
        if old_id.isdigit():
            run(["/usr/sbin/setquota", "-P", old_id, "0", "0", "0", "0", "/"])
            managed.pop(old_id, None)

    eligible: list[tuple[dict[str, object], int, Path]] = []
    database_status: dict[str, dict[str, object]] = {}
    for row in databases:
        project_id = int(row["id"])
        project_key = str(project_id)
        directory = path / "base" / project_key
        if row.get("eligible") is not True or not directory.is_dir() or directory.is_symlink():
            database_status[project_key] = {
                "database": str(row["name"]),
                "usedBytes": int(row.get("sizeBytes", 0)),
                "hardLimitBytes": 0,
                "hardLimitEnforced": False,
            }
            continue
        if project_key not in managed or managed[project_key] != str(directory):
            assign_project_tree(project_id, directory)
            managed[project_key] = str(directory)
        else:
            # Keep the inherited project ID and cross-database rename protection in place.
            run(["/usr/bin/chattr", "-p", project_key, "+P", str(directory)], timeout=30)
        eligible.append((row, project_id, directory))

    disk = shutil.disk_usage(path)
    growth_budget = max(0, disk.free - RESERVE_BYTES) * growth // 100
    per_database_growth = growth_budget // len(eligible) if eligible else 0

    # Refresh project usage after assigning existing files to their database project IDs.
    records = project_quota_records()
    for row, project_id, _directory in eligible:
        key = str(project_id)
        used_bytes = records.get(key, {}).get("usedKib", 0) * 1024
        requested_kib = max(1, (used_bytes + per_database_growth + 1023) // 1024)
        run(["/usr/sbin/setquota", "-P", key, "0", str(requested_kib), "0", "0", "/"])

    records = project_quota_records()
    for row, project_id, _directory in eligible:
        key = str(project_id)
        record = records.get(key, {})
        used_bytes = record.get("usedKib", 0) * 1024
        hard_bytes = record.get("hardKib", 0) * 1024
        requested_kib = max(1, (used_bytes + per_database_growth + 1023) // 1024)
        database_status[key] = {
            "database": str(row["name"]),
            "usedBytes": used_bytes,
            "hardLimitBytes": hard_bytes,
            "hardLimitEnforced": hard_bytes == requested_kib * 1024,
        }

    write_json(MANAGED_FILE, managed, 0o600)
    enabled = bool(eligible) and all(
        database_status[str(project_id)]["hardLimitEnforced"] is True
        for _row, project_id, _directory in eligible
    )
    write_json(
        STATUS_FILE,
        {
            "enabled": enabled,
            "filesystemEnabled": True,
            "method": "ext4-project-quota",
            "reason": None if enabled else "One or more database project quotas could not be verified.",
            "lastReconciledAt": datetime.now(timezone.utc).isoformat(),
            "growthPercent": growth,
            "reserveBytes": RESERVE_BYTES,
            "databases": database_status,
        },
        0o644,
    )


if __name__ == "__main__":
    if sys.argv[1:] != ["reconcile"]:
        raise SystemExit("usage: nanogres-quota reconcile")
    try:
        reconcile()
    except QuotaError as error:
        current = None
        try:
            current = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
        if not isinstance(current, dict) or current.get("enabled") is not True:
            mark_unavailable(str(error))
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
