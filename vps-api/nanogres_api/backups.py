"""Database backup creation, retention cleanup, downloads, and restore/upload handling."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote

from . import config as _config
from . import pg as _pg
from . import quotas_offsite as _quotas_offsite
from . import tenants as _tenants
from .config import (
    ApiError,
    BACKUP_PATTERN,
    NAME_PATTERN,
    TRANSFER_INTERNAL_PATTERN,
    UPLOAD_ID_PATTERN,
    backup_lock,
    quota_policy_lock,
)
from .pg import quote_identifier, quote_literal


def list_backups(organization_id: object) -> list[dict[str, object]]:
    """List local `.dump` backups belonging to an organization, newest first."""
    backup_dir = _config.resolve("organization_backup_dir", _tenants.organization_backup_dir)(
        organization_id
    )
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


def cleanup_old_backups() -> int:
    """Delete local backup files older than `BACKUP_RETENTION_DAYS`."""
    retention_days = _config.cfg("BACKUP_RETENTION_DAYS")
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    removed = 0
    backup_dir = _config.cfg("BACKUP_DIR")
    if not backup_dir.exists():
        return removed
    for path in backup_dir.rglob("*"):
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
    run_sql = _config.resolve("run_sql", _pg.run_sql)
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
    pg_client = _config.resolve("pg_client", _pg.pg_client)
    pg_client_env = _config.resolve("pg_client_env", _pg.pg_client_env)
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
    _config.resolve("cleanup_old_backups", cleanup_old_backups)()
    _config.resolve("record_event", _tenants.record_event)(
        "backup.created",
        f"Backup created for {display_database}.",
        actor,
        organization_id,
        organization_prefix_value,
    )
    if upload_offsite:
        _config.resolve("request_offsite_backup", _quotas_offsite.request_offsite_backup)()
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
    """Create a custom-format `pg_dump` backup for a tenant database."""
    _config.resolve("tenant_resource_name", _tenants.tenant_resource_name)(
        organization_id, database, "Database name"
    )
    physical_name = _config.resolve(
        "organization_database_name", _tenants.organization_database_name
    )(organization_id, database)
    backup_dir = _config.resolve("organization_backup_dir", _tenants.organization_backup_dir)(
        organization_id
    )
    return _config.resolve("_create_backup_physical", _create_backup_physical)(
        physical_name,
        str(database),
        backup_dir,
        actor,
        timeout_seconds,
        upload_offsite,
        organization_id,
    )


def _prepare_restore_target(
    organization_id: object,
    target_name: str,
    query_role: str,
    cleanup_dir: Path | None = None,
) -> None:
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    clear_quota = _config.resolve(
        "clear_database_quota_setting", _quotas_offsite.clear_database_quota_setting
    )
    prepare_db = _config.resolve(
        "prepare_organization_database", _tenants.prepare_organization_database
    )
    reconcile = _config.resolve("request_quota_reconcile", _quotas_offsite.request_quota_reconcile)

    with quota_policy_lock:
        if (
            run_sql(
                f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(target_name)})"
            )
            == "t"
        ):
            raise ApiError(
                409,
                "A database with that name already exists. Restore never overwrites a database.",
            )

        clear_quota(target_name)
        run_sql(
            f"CREATE DATABASE {quote_identifier(target_name)} OWNER {quote_identifier(query_role)} "
            "ENCODING 'UTF8' TEMPLATE template0"
        )
        prepare_db(organization_id, target_name)
        try:
            reconcile(target_name)
        except ApiError:
            run_sql(f"DROP DATABASE {quote_identifier(target_name)}")
            if cleanup_dir is not None:
                shutil.rmtree(cleanup_dir, ignore_errors=True)
            raise


def _drop_failed_restore_database(target_name: str, cleanup_dir: Path | None = None) -> None:
    try:
        _config.resolve("run_sql", _pg.run_sql)(f"DROP DATABASE {quote_identifier(target_name)}")
    except (ApiError, OSError, subprocess.SubprocessError):
        raise ApiError(
            503,
            "Restore failed; the new database may be incomplete and needs cleanup.",
        )
    if cleanup_dir is not None:
        shutil.rmtree(cleanup_dir, ignore_errors=True)
    raise ApiError(503, "Restore failed; the new database was removed.")


def restore_backup(
    organization_id: object,
    encoded_name: str,
    target: object,
    actor: str | None = None,
) -> dict[str, object]:
    """Restore an existing backup archive into a newly created tenant database."""
    filename = unquote(encoded_name)
    match = BACKUP_PATTERN.fullmatch(filename)
    if not match:
        raise ApiError(404, "Backup not found.")
    _config.resolve("tenant_resource_name", _tenants.tenant_resource_name)(
        organization_id, match.group(1), "Backup database name"
    )
    logical_target = str(target) if isinstance(target, str) else ""
    target_name = _config.resolve(
        "organization_database_name", _tenants.organization_database_name
    )(organization_id, logical_target)
    query_role = _config.resolve(
        "ensure_organization_query_role", _tenants.ensure_organization_query_role
    )(organization_id)

    backup_path = (
        _config.resolve("organization_backup_dir", _tenants.organization_backup_dir)(
            organization_id
        )
        / filename
    )
    if not backup_path.is_file() or backup_path.is_symlink():
        raise ApiError(404, "Backup not found.")

    pg_client = _config.resolve("pg_client", _pg.pg_client)
    with backup_lock:
        _prepare_restore_target(organization_id, target_name, query_role)
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
        env = _config.resolve("organization_query_env", _tenants.organization_query_env)(
            organization_id
        )
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
            _drop_failed_restore_database(target_name)
        _config.resolve("transfer_database_objects", _tenants.transfer_database_objects)(
            target_name, query_role
        )

    _config.resolve("record_event", _tenants.record_event)(
        "backup.restored",
        f"Backup {filename} restored as new database {logical_target}.",
        actor,
        organization_id,
    )
    return {"database": logical_target, "restoredFrom": filename}


def cleanup_old_restore_uploads() -> int:
    """Remove expired chunked restore upload staging directories."""
    removed = 0
    upload_dir = _config.cfg("RESTORE_UPLOAD_DIR")
    if not upload_dir.exists():
        return removed
    cutoff = datetime.now(timezone.utc) - _config.cfg("RESTORE_UPLOAD_TTL")
    for path in upload_dir.iterdir():
        if not UPLOAD_ID_PATTERN.fullmatch(path.name) or path.is_symlink() or not path.is_dir():
            continue
        if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < cutoff:
            shutil.rmtree(path)
            removed += 1
    return removed


def restore_upload_path(upload_id: str) -> Path:
    """Validate and resolve a chunked restore upload directory."""
    if not UPLOAD_ID_PATTERN.fullmatch(upload_id):
        raise ApiError(404, "Restore upload not found.")
    path = _config.cfg("RESTORE_UPLOAD_DIR") / upload_id
    if not path.is_dir() or path.is_symlink():
        raise ApiError(404, "Restore upload not found.")
    return path


def read_restore_upload(
    upload_id: str,
    organization_id: object,
) -> tuple[Path, dict[str, int]]:
    """Load and verify organization-scoped metadata for an in-progress restore upload."""
    path = _config.resolve("restore_upload_path", restore_upload_path)(upload_id)
    try:
        metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(404, "Restore upload not found.") from error
    size_bytes = metadata.get("sizeBytes") if isinstance(metadata, dict) else None
    expected_prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(
        organization_id
    )
    if not isinstance(metadata, dict) or metadata.get("organizationPrefix") != expected_prefix:
        raise ApiError(404, "Restore upload not found.")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        raise ApiError(400, "Restore upload metadata is invalid.")
    chunk_bytes = _config.cfg("TRANSFER_CHUNK_BYTES")
    chunk_count = (size_bytes + chunk_bytes - 1) // chunk_bytes
    return path, {"sizeBytes": size_bytes, "chunkCount": chunk_count}


def create_restore_upload(
    body: dict[str, object],
    organization_id: object,
) -> dict[str, object]:
    """Initialize a chunked dump upload session after verifying free disk space."""
    size_bytes = body.get("sizeBytes")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        raise ApiError(400, "Choose a non-empty PostgreSQL dump file.")

    upload_dir = _config.cfg("RESTORE_UPLOAD_DIR")
    upload_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    _config.resolve("cleanup_old_restore_uploads", cleanup_old_restore_uploads)()
    if shutil.disk_usage(_config.cfg("STATE_DIR")).free < (
        size_bytes + _config.cfg("RESTORE_UPLOAD_DISK_RESERVE_BYTES")
    ):
        raise ApiError(413, "There is not enough free VPS disk space for this upload.")

    upload_id = uuid.uuid4().hex
    upload_path = upload_dir / upload_id
    upload_path.mkdir(mode=0o700)
    metadata_path = upload_path / "metadata.json"
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    metadata_path.write_text(
        json.dumps({"sizeBytes": size_bytes, "organizationPrefix": prefix}),
        encoding="utf-8",
    )
    os.chmod(metadata_path, 0o600)
    chunk_bytes = _config.cfg("TRANSFER_CHUNK_BYTES")
    return {
        "uploadId": upload_id,
        "chunkSizeBytes": chunk_bytes,
        "chunkCount": (size_bytes + chunk_bytes - 1) // chunk_bytes,
    }


def store_restore_chunk(
    upload_id: str,
    chunk_index: int,
    body: bytes,
    organization_id: object,
) -> dict[str, int]:
    """Validate and atomically store a single upload chunk."""
    upload_path, metadata = _config.resolve("read_restore_upload", read_restore_upload)(
        upload_id, organization_id
    )
    chunk_count = metadata["chunkCount"]
    if chunk_index < 0 or chunk_index >= chunk_count:
        raise ApiError(404, "Restore upload chunk not found.")
    chunk_bytes = _config.cfg("TRANSFER_CHUNK_BYTES")
    expected_size = min(chunk_bytes, metadata["sizeBytes"] - chunk_index * chunk_bytes)
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
    """Stream uploaded dump chunks directly into `pg_restore` via stdin."""
    env = env or _config.resolve("pg_client_env", _pg.pg_client_env)("10")
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
    """Assemble and restore a completed chunked dump upload into a new database."""
    upload_path, metadata = _config.resolve("read_restore_upload", read_restore_upload)(
        upload_id, organization_id
    )
    logical_target = str(target) if isinstance(target, str) else ""
    target_name = _config.resolve(
        "organization_database_name", _tenants.organization_database_name
    )(organization_id, logical_target)
    query_role = _config.resolve(
        "ensure_organization_query_role", _tenants.ensure_organization_query_role
    )(organization_id)

    expected_chunks = metadata["chunkCount"]
    chunk_bytes = _config.cfg("TRANSFER_CHUNK_BYTES")
    for index in range(expected_chunks):
        chunk_path = upload_path / f"chunk-{index:08d}.part"
        expected_size = min(chunk_bytes, metadata["sizeBytes"] - index * chunk_bytes)
        if (
            chunk_path.is_symlink()
            or not chunk_path.is_file()
            or chunk_path.stat().st_size != expected_size
        ):
            raise ApiError(400, "The uploaded backup is incomplete.")

    pg_client = _config.resolve("pg_client", _pg.pg_client)
    run_upload_restore = _config.resolve(
        "run_pg_restore_from_upload", run_pg_restore_from_upload
    )
    with backup_lock:
        _prepare_restore_target(organization_id, target_name, query_role, cleanup_dir=upload_path)
        result = run_upload_restore(
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
            env=_config.resolve("organization_query_env", _tenants.organization_query_env)(
                organization_id
            ),
        )
        if result is None or result != 0:
            _drop_failed_restore_database(target_name, cleanup_dir=upload_path)
        try:
            _config.resolve("transfer_database_objects", _tenants.transfer_database_objects)(
                target_name, query_role
            )
        except (ApiError, OSError, subprocess.SubprocessError):
            _drop_failed_restore_database(target_name, cleanup_dir=upload_path)

    shutil.rmtree(upload_path)
    _config.resolve("record_event", _tenants.record_event)(
        "backup.restored",
        f"Uploaded PostgreSQL dump restored as new database {logical_target}.",
        actor,
        organization_id,
    )
    return {"database": logical_target, "restoredFrom": "uploaded file"}


def backup_all() -> int:
    """Create backups for all user databases across all organizations."""
    _config.resolve("cleanup_old_restore_uploads", cleanup_old_restore_uploads)()
    databases = [
        row["name"]
        for row in _config.resolve("list_databases", _tenants.list_databases)()
        if row.get("name") != "postgres"
    ]
    backup_dir_root = _config.cfg("BACKUP_DIR")
    create_physical = _config.resolve("_create_backup_physical", _create_backup_physical)
    completed = 0
    for physical_name in databases:
        if not isinstance(physical_name, str) or not NAME_PATTERN.fullmatch(physical_name):
            continue
        match = re.fullmatch(r"(n[0-9a-f]{24}_)([a-z][a-z0-9_]{0,36})", physical_name)
        if match:
            if TRANSFER_INTERNAL_PATTERN.fullmatch(match.group(2)):
                continue
            backup_dir = backup_dir_root / match.group(1).rstrip("_")
            display_name = match.group(2)
        else:
            # Keep pre-tenant databases backed up until the operator migrates them.
            backup_dir = backup_dir_root / "legacy"
            display_name = physical_name
        create_physical(
            physical_name,
            display_name,
            backup_dir,
            upload_offsite=False,
            organization_prefix_value=match.group(1) if match else None,
        )
        completed += 1
    _config.resolve("cleanup_old_backups", cleanup_old_backups)()
    return completed


def download_backup(
    handler: BaseHTTPRequestHandler,
    organization_id: object,
    encoded_name: str,
    query: dict[str, list[str]],
) -> None:
    """Stream a validated byte range of an organization's backup file as HTTP 206."""
    filename = unquote(encoded_name)
    match = BACKUP_PATTERN.fullmatch(filename)
    if not match:
        raise ApiError(404, "Backup not found.")
    _config.resolve("tenant_resource_name", _tenants.tenant_resource_name)(
        organization_id, match.group(1), "Backup database name"
    )
    path = (
        _config.resolve("organization_backup_dir", _tenants.organization_backup_dir)(
            organization_id
        )
        / filename
    )
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
    if (
        offset < 0
        or offset >= total_size
        or length <= 0
        or length > _config.cfg("TRANSFER_CHUNK_BYTES")
    ):
        raise ApiError(416, "Download range is invalid.")
    chunk_size = min(length, total_size - offset)
    handler.send_response(206)
    handler.send_header("Content-Type", "application/octet-stream")
    handler.send_header("Content-Length", str(chunk_size))
    handler.send_header("Content-Range", f"bytes {offset}-{offset + chunk_size - 1}/{total_size}")
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    handler.send_header("Cache-Control", "private, no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()
    with path.open("rb") as handle:
        handle.seek(offset)
        remaining = chunk_size
        while remaining:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)
