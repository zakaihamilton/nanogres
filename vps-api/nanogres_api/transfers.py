"""External PostgreSQL import/export jobs, staging DB management, and crash recovery."""

from __future__ import annotations

import ipaddress
import json
import os
import shutil
import socket
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from . import config as _config
from . import pg as _pg
from . import quotas_offsite as _quotas_offsite
from . import tenants as _tenants
from .config import (
    ApiError,
    TRANSFER_JOB_PATTERN,
    backup_lock,
    quota_policy_lock,
    transfer_lock,
)
from .pg import quote_identifier, quote_literal

transfer_jobs: dict[str, dict[str, object]] = {}
transfer_workers: dict[str, threading.Thread] = {}
transfer_processes: dict[str, subprocess.Popen[str]] = {}
transfer_cancel_events: dict[str, threading.Event] = {}


def _transfer_metadata_path(transfer_id: str) -> Path:
    if not TRANSFER_JOB_PATTERN.fullmatch(transfer_id):
        raise ApiError(404, "Transfer not found.")
    return _config.cfg("TRANSFER_DIR") / f"{transfer_id}.json"


def _write_transfer_metadata(job: dict[str, object]) -> None:
    _config.cfg("TRANSFER_DIR").mkdir(mode=0o700, parents=True, exist_ok=True)
    path = _config.resolve("_transfer_metadata_path", _transfer_metadata_path)(
        str(job["transferId"])
    )
    _config.atomic_write_text(
        path,
        json.dumps(job, separators=(",", ":")),
        prefix=f".{path.name}.",
    )


def _public_transfer_job(job: dict[str, object]) -> dict[str, object]:
    result = {
        key: job.get(key)
        for key in (
            "transferId",
            "direction",
            "status",
            "phase",
            "message",
            "sourceDatabase",
            "targetDatabase",
            "createdAt",
            "updatedAt",
            "completedAt",
            "recoveryBackupRetained",
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
    path = _config.resolve("_transfer_metadata_path", _transfer_metadata_path)(transfer_id)
    try:
        job = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(404, "Transfer not found.") from error
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    if not isinstance(job, dict) or job.get("organizationPrefix") != prefix:
        raise ApiError(404, "Transfer not found.")
    return job


def list_transfer_jobs(organization_id: object) -> list[dict[str, object]]:
    """List recent transfer jobs scoped to an organization."""
    transfer_dir = _config.cfg("TRANSFER_DIR")
    transfer_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    jobs = []
    for path in transfer_dir.glob("[0-9a-f]" * 32 + ".json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and value.get("organizationPrefix") == prefix:
            jobs.append(_public_transfer_job(value))
    return sorted(jobs, key=lambda value: str(value.get("createdAt", "")), reverse=True)[:20]


def _update_transfer_job(transfer_id: str, **changes: object) -> dict[str, object]:
    jobs = _config.resolve("transfer_jobs", transfer_jobs)
    with transfer_lock:
        job = jobs.get(transfer_id)
        if job is None:
            try:
                path = _config.resolve("_transfer_metadata_path", _transfer_metadata_path)(
                    transfer_id
                )
                job = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ApiError(404, "Transfer not found.") from error
        job.update(changes)
        job["updatedAt"] = datetime.now(timezone.utc).isoformat()
        jobs[transfer_id] = job
        _config.resolve("_write_transfer_metadata", _write_transfer_metadata)(job)
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
        if any(
            ord(character) < 32 or ord(character) == 127
            for value in (host, database, username, password)
            for character in value
        ):
            raise ValueError("control character in connection detail")
    except (ValueError, UnicodeError) as error:
        raise ApiError(
            400, "Enter a PostgreSQL URL with a database, username, and password."
        ) from error

    address = _resolved_public_address(host, port)
    conninfo = " ".join(
        f"{key}={_quote_conninfo(value)}"
        for key, value in (
            ("host", host),
            ("hostaddr", address),
            ("port", str(port)),
            ("dbname", database),
            ("user", username),
            ("sslmode", "verify-full"),
            ("channel_binding", channel_binding),
        )
    )
    passfile = work_dir / "pgpass"
    passfile.write_text(
        ":".join(_passfile_escape(value) for value in (host, str(port), database, username, password))
        + "\n",
        encoding="utf-8",
    )
    os.chmod(passfile, 0o600)
    env = _config.resolve("pg_client_env", _pg.pg_client_env)("10")
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
    cancel_events = _config.resolve("transfer_cancel_events", transfer_cancel_events)
    processes = _config.resolve("transfer_processes", transfer_processes)
    if cancel_events[transfer_id].is_set() and not bypass_cancel:
        raise ApiError(409, "Transfer was cancelled.")
    _config.resolve("_update_transfer_job", _update_transfer_job)(
        transfer_id, phase=phase, message=phase.replace("_", " ").capitalize()
    )
    with transfer_lock:
        # Serialize process startup with cancel_transfer_job: otherwise a cancel
        # can set the event after the check above but before this process is
        # visible in transfer_processes, leaving it running until it exits.
        if cancel_events[transfer_id].is_set() and not bypass_cancel:
            raise ApiError(409, "Transfer was cancelled.")
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        processes[transfer_id] = process
    try:
        stdout, stderr = process.communicate(timeout=_config.cfg("TRANSFER_TIMEOUT_SECONDS"))
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
            processes.pop(transfer_id, None)
    if cancel_events[transfer_id].is_set() and not bypass_cancel:
        raise ApiError(409, "Transfer was cancelled.")
    if process.returncode:
        # Never expose client stderr: some libpq errors echo connection details.
        detail = (stderr or "").lower()
        if "server version" in detail or "newer than" in detail:
            raise ApiError(400, "The VPS PostgreSQL tools do not support that database version.")
        if any(
            marker in detail
            for marker in (
                "authentication failed",
                "could not translate host",
                "connection timed out",
                "connection refused",
                "ssl error",
                "certificate verify failed",
                "no pg_hba.conf entry",
            )
        ):
            raise ApiError(
                400,
                "Could not connect to the PostgreSQL database. Check credentials, TLS, and provider network access.",
            )
        raise ApiError(503, "PostgreSQL could not complete the transfer step.")
    return stdout or ""


def _external_sql(transfer_id: str, conninfo: str, env: dict[str, str], statement: str) -> str:
    pg_client = _config.resolve("pg_client", _pg.pg_client)
    return _config.resolve("_transfer_command", _transfer_command)(
        transfer_id,
        "checking_external_database",
        [pg_client("psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "--dbname", conninfo, "-c", statement],
        env,
        capture_stdout=True,
    ).strip()


def _new_staging_database(organization_id: object, staging_name: str, owner: str) -> None:
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    _config.resolve(
        "clear_database_quota_setting", _quotas_offsite.clear_database_quota_setting
    )(staging_name)
    run_sql(
        f"CREATE DATABASE {quote_identifier(staging_name)} OWNER {quote_identifier(owner)} "
        "ENCODING 'UTF8' TEMPLATE template0"
    )
    try:
        _config.resolve("prepare_organization_database", _tenants.prepare_organization_database)(
            organization_id, staging_name
        )
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
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    target_name = _config.resolve("organization_database_name", _tenants.organization_database_name)(
        organization_id, logical_target
    )
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    backup_name = prefix + "transfer_old_" + transfer_id[:24]
    cancel_events = _config.resolve("transfer_cancel_events", transfer_cancel_events)
    update_job = _config.resolve("_update_transfer_job", _update_transfer_job)

    with backup_lock:
        with quota_policy_lock:
            target_exists = (
                run_sql(
                    f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(target_name)})"
                )
                == "t"
            )
            if mode == "new" and target_exists:
                raise ApiError(409, "A database with that name already exists.")
            if mode == "replace" and not target_exists:
                raise ApiError(404, "The database selected for replacement no longer exists.")
            with transfer_lock:
                if cancel_events[transfer_id].is_set():
                    raise ApiError(409, "Transfer was cancelled.")
                update_job(
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
                run_sql(
                    f"ALTER DATABASE {quote_identifier(target_name)} RENAME TO {quote_identifier(backup_name)}"
                )
                update_job(transfer_id, oldDatabaseRenamed=True)
            update_job(transfer_id, swapAttempted=True)
            try:
                run_sql(
                    f"ALTER DATABASE {quote_identifier(staging_name)} RENAME TO {quote_identifier(target_name)}"
                )
            except (ApiError, OSError, subprocess.SubprocessError):
                if target_exists:
                    run_sql(
                        f"ALTER DATABASE {quote_identifier(backup_name)} RENAME TO {quote_identifier(target_name)}"
                    )
                run_sql(f"DROP DATABASE {quote_identifier(staging_name)}")
                raise
            update_job(transfer_id, newDatabaseRenamed=True)
            if target_exists:
                run_sql(f"DROP DATABASE {quote_identifier(backup_name)}")
            try:
                _config.resolve(
                    "request_quota_reconcile", _quotas_offsite.request_quota_reconcile
                )(target_name)
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
    pg_client = _config.resolve("pg_client", _pg.pg_client)
    transfer_cmd = _config.resolve("_transfer_command", _transfer_command)
    script_path = work_dir / f"{phase}.sql"
    restore_command = [pg_client("pg_restore"), "--exit-on-error", "--no-owner"]
    if not include_acls:
        restore_command.append("--no-acl")
    restore_command.extend(["--file", str(script_path), str(archive)])
    transfer_cmd(
        transfer_id,
        "preparing_external_restore",
        restore_command,
        env,
        bypass_cancel=bypass_cancel,
    )
    if clear_first:
        content = script_path.read_text(encoding="utf-8")
        script_path.write_text(_external_database_reset_sql() + "\n" + content, encoding="utf-8")
    transfer_cmd(
        transfer_id,
        phase,
        [
            pg_client("psql"),
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "--single-transaction",
            "--file",
            str(script_path),
            "--dbname",
            conninfo,
        ],
        env,
        bypass_cancel=bypass_cancel,
    )


def _export_transfer(
    transfer_id: str, job: dict[str, object], raw_connection: str, work_dir: Path
) -> None:
    organization_id = str(job["organizationId"])
    source_database = str(job["sourceDatabase"])
    source_name = _config.resolve(
        "require_organization_database", _tenants.require_organization_database
    )(organization_id, source_database)
    conninfo, env = _config.resolve("_external_connection", _external_connection)(
        raw_connection, work_dir
    )
    pg_client = _config.resolve("pg_client", _pg.pg_client)
    pg_client_env = _config.resolve("pg_client_env", _pg.pg_client_env)
    transfer_cmd = _config.resolve("_transfer_command", _transfer_command)
    restore_archive = _config.resolve("_restore_external_archive", _restore_external_archive)

    target_mode = str(job["targetMode"])
    target_dump = work_dir / "nanogres.dump"
    rollback_dump = work_dir / "external-before.dump"
    transfer_cmd(
        transfer_id,
        "dumping_nanogres_database",
        [
            pg_client("pg_dump"),
            "--format=custom",
            "--no-owner",
            "--no-acl",
            "--file",
            str(target_dump),
            "--dbname",
            source_name,
        ],
        pg_client_env("10"),
    )
    if target_mode == "empty":
        has_user_objects = _config.resolve("_external_sql", _external_sql)(
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
            "EXISTS (SELECT 1 FROM pg_publication)",
        )
        if has_user_objects == "t":
            raise ApiError(
                409,
                "The external database is not empty. Choose replace only if you intend to overwrite it.",
            )
    else:
        transfer_cmd(
            transfer_id,
            "saving_external_rollback_copy",
            [
                pg_client("pg_dump"),
                "--format=custom",
                "--no-owner",
                "--file",
                str(rollback_dump),
                "--dbname",
                conninfo,
            ],
            env,
        )

    try:
        if target_mode == "replace":
            restore_archive(
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
            transfer_cmd(
                transfer_id,
                "restoring_external_database",
                [
                    pg_client("pg_restore"),
                    "--exit-on-error",
                    "--single-transaction",
                    "--no-owner",
                    "--no-acl",
                    "--dbname",
                    conninfo,
                    str(target_dump),
                ],
                env,
            )
    except (ApiError, OSError, subprocess.SubprocessError) as transfer_error:
        if target_mode == "replace" and rollback_dump.exists():
            try:
                restore_archive(
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
                _config.resolve("_update_transfer_job", _update_transfer_job)(
                    transfer_id, recoveryBackupRetained=True
                )
                raise ApiError(
                    503,
                    "Transfer failed and the previous external database could not be restored. A recovery copy remains on the VPS.",
                ) from rollback_error
        raise transfer_error
    _config.resolve("record_event", _tenants.record_event)(
        "database.exported",
        f"Exported {source_database} to an external PostgreSQL database.",
        str(job.get("actor")),
        organization_id,
    )


def _import_transfer(
    transfer_id: str, job: dict[str, object], raw_connection: str, work_dir: Path
) -> None:
    organization_id = str(job["organizationId"])
    logical_target = str(job["targetDatabase"])
    mode = str(job["targetMode"])
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    staging_name = prefix + "transfer_" + transfer_id[:24]
    owner = _config.resolve(
        "ensure_organization_query_role", _tenants.ensure_organization_query_role
    )(organization_id)
    dump_file = work_dir / "external.dump"
    conninfo, env = _config.resolve("_external_connection", _external_connection)(
        raw_connection, work_dir
    )
    pg_client = _config.resolve("pg_client", _pg.pg_client)
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    transfer_cmd = _config.resolve("_transfer_command", _transfer_command)
    cancel_events = _config.resolve("transfer_cancel_events", transfer_cancel_events)

    try:
        transfer_cmd(
            transfer_id,
            "dumping_external_database",
            [
                pg_client("pg_dump"),
                "--format=custom",
                "--no-owner",
                "--no-acl",
                "--file",
                str(dump_file),
                "--dbname",
                conninfo,
            ],
            env,
        )
        _config.resolve("_new_staging_database", _new_staging_database)(
            organization_id, staging_name, owner
        )
        transfer_cmd(
            transfer_id,
            "restoring_nanogres_database",
            [
                pg_client("pg_restore"),
                "--exit-on-error",
                "--single-transaction",
                "--no-owner",
                "--no-acl",
                "--dbname",
                staging_name,
                str(dump_file),
            ],
            _config.resolve("organization_query_env", _tenants.organization_query_env)(
                organization_id
            ),
        )
        _config.resolve("transfer_database_objects", _tenants.transfer_database_objects)(
            staging_name, owner
        )
        if cancel_events[transfer_id].is_set():
            raise ApiError(409, "Transfer was cancelled.")
        _config.resolve("_replace_nanogres_database", _replace_nanogres_database)(
            organization_id, staging_name, logical_target, mode, transfer_id
        )
    except (ApiError, OSError, subprocess.SubprocessError):
        exists = (
            run_sql(
                f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(staging_name)})"
            )
            == "t"
        )
        if exists:
            run_sql(f"DROP DATABASE {quote_identifier(staging_name)}")
        raise
    _config.resolve("record_event", _tenants.record_event)(
        "database.imported" if mode == "new" else "database.imported_replaced",
        f"Imported an external PostgreSQL database as {logical_target}.",
        str(job.get("actor")),
        organization_id,
    )


def _run_transfer_job(transfer_id: str, raw_connection: str) -> None:
    transfer_dir = _config.cfg("TRANSFER_DIR")
    work_dir = transfer_dir / transfer_id
    jobs = _config.resolve("transfer_jobs", transfer_jobs)
    cancel_events = _config.resolve("transfer_cancel_events", transfer_cancel_events)
    processes = _config.resolve("transfer_processes", transfer_processes)
    workers = _config.resolve("transfer_workers", transfer_workers)
    update_job = _config.resolve("_update_transfer_job", _update_transfer_job)

    job = jobs[transfer_id]
    try:
        work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(work_dir, 0o700)
        update_job(transfer_id, status="running", phase="starting", message="Starting transfer")
        if job["direction"] == "import":
            _config.resolve("_import_transfer", _import_transfer)(
                transfer_id, job, raw_connection, work_dir
            )
        else:
            _config.resolve("_export_transfer", _export_transfer)(
                transfer_id, job, raw_connection, work_dir
            )
        update_job(
            transfer_id,
            status="succeeded",
            phase="complete",
            message="Transfer completed",
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    except ApiError as error:
        status = (
            "cancelled" if error.status == 409 and cancel_events[transfer_id].is_set() else "failed"
        )
        update_job(
            transfer_id,
            status=status,
            phase=status,
            message=error.message,
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    except (OSError, subprocess.SubprocessError):
        update_job(
            transfer_id,
            status="failed",
            phase="failed",
            message="The transfer could not complete because of a VPS or PostgreSQL error.",
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    except Exception:
        update_job(
            transfer_id,
            status="failed",
            phase="failed",
            message="The transfer could not complete because of an unexpected VPS error.",
            completedAt=datetime.now(timezone.utc).isoformat(),
        )
    finally:
        try:
            if jobs[transfer_id].get("recoveryBackupRetained"):
                retained = work_dir / "external-before.dump"
                if retained.is_file():
                    destination = transfer_dir / f"{transfer_id}.recovery.dump"
                    try:
                        os.chmod(retained, 0o600)
                        os.replace(retained, destination)
                    except OSError:
                        jobs[transfer_id]["recoveryBackupRetained"] = False
                        try:
                            update_job(
                                transfer_id,
                                recoveryBackupRetained=False,
                                message="Transfer and automatic recovery failed. The recovery copy could not be retained; check the external database.",
                            )
                        except (ApiError, OSError):
                            pass
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
            with transfer_lock:
                processes.pop(transfer_id, None)
                cancel_events.pop(transfer_id, None)
                workers.pop(transfer_id, None)


def create_transfer_job(
    body: dict[str, object], organization_id: object, actor: str | None
) -> dict[str, object]:
    """Validate parameters and launch a background database import or export job."""
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
        _config.resolve("tenant_resource_name", _tenants.tenant_resource_name)(
            organization_id, target, "Database name"
        )
        source = "external PostgreSQL"
        target_database = str(target)
    else:
        source = body.get("sourceDatabase")
        _config.resolve("require_organization_database", _tenants.require_organization_database)(
            organization_id, source
        )
        target_database = "external PostgreSQL"

    jobs = _config.resolve("transfer_jobs", transfer_jobs)
    cancel_events = _config.resolve("transfer_cancel_events", transfer_cancel_events)
    workers = _config.resolve("transfer_workers", transfer_workers)

    with transfer_lock:
        active = sum(
            1
            for item in jobs.values()
            if item.get("status") in {"queued", "running", "cancelling"}
        )
        if active >= _config.cfg("TRANSFER_MAX_ACTIVE"):
            raise ApiError(429, "Nanogres already has the maximum number of active transfers.")
        transfer_id = uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        job = {
            "transferId": transfer_id,
            "organizationPrefix": _config.resolve(
                "organization_prefix", _tenants.organization_prefix
            )(organization_id),
            "organizationId": _config.resolve(
                "normalized_organization_id", _tenants.normalized_organization_id
            )(organization_id),
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
        jobs[transfer_id] = job
        cancel_events[transfer_id] = threading.Event()
        _config.resolve("_write_transfer_metadata", _write_transfer_metadata)(job)
        worker = threading.Thread(
            target=_config.resolve("_run_transfer_job", _run_transfer_job),
            args=(transfer_id, raw_connection),
            daemon=True,
            name=f"nanogres-transfer-{transfer_id[:8]}",
        )
        workers[transfer_id] = worker
        worker.start()
    return _public_transfer_job(job)


def cancel_transfer_job(transfer_id: str, organization_id: object) -> dict[str, object]:
    """Request cancellation of an active transfer job unless it is in its final swap phase."""
    job = _config.resolve("_load_transfer_job", _load_transfer_job)(transfer_id, organization_id)
    jobs = _config.resolve("transfer_jobs", transfer_jobs)
    cancel_events = _config.resolve("transfer_cancel_events", transfer_cancel_events)
    processes = _config.resolve("transfer_processes", transfer_processes)

    with transfer_lock:
        current = jobs.get(transfer_id, job)
        if current.get("status") not in {"queued", "running", "cancelling"}:
            raise ApiError(409, "This transfer has already finished.")
        if (
            current.get("swapStarted") is True
            or str(current.get("phase", "")).startswith("recovering")
            or current.get("phase") == "restoring_external_rollback_copy"
        ):
            raise ApiError(
                409,
                "This transfer is in its final replacement step and can no longer be cancelled safely.",
            )
        event = cancel_events.get(transfer_id)
        if event:
            event.set()
        process = processes.get(transfer_id)
        if process and process.poll() is None:
            process.terminate()
        current.update({"phase": "cancelling", "message": "Cancelling transfer"})
        current["updatedAt"] = datetime.now(timezone.utc).isoformat()
        jobs[transfer_id] = current
        _config.resolve("_write_transfer_metadata", _write_transfer_metadata)(current)
        return _public_transfer_job(current)


def _transfer_database_exists(name: str) -> bool:
    return (
        _config.resolve("run_sql", _pg.run_sql)(
            f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(name)})"
        )
        == "t"
    )


def _drop_transfer_database(name: str) -> None:
    if not _transfer_database_exists(name):
        return
    run_sql = _config.resolve("run_sql", _pg.run_sql)
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
        target_name = _config.resolve(
            "organization_database_name", _tenants.organization_database_name
        )(organization_id, target_value)
    except ApiError:
        return
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    staging_name = prefix + "transfer_" + transfer_id[:24]
    backup_name = prefix + "transfer_old_" + transfer_id[:24]
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    update_job = _config.resolve("_update_transfer_job", _update_transfer_job)

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
            run_sql(
                f"ALTER DATABASE {quote_identifier(backup_name)} RENAME TO {quote_identifier(target_name)}"
            )
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
                update_job(
                    transfer_id,
                    status="succeeded",
                    phase="complete",
                    message="Transfer completed before the VPS restarted",
                    completedAt=now,
                )
                _config.resolve("record_event", _tenants.record_event)(
                    "database.imported_recovered",
                    f"Recovered completed database import as {target_value} after a VPS restart.",
                    str(job.get("actor")),
                    organization_id,
                )
            else:
                update_job(
                    transfer_id,
                    status="failed",
                    phase="failed",
                    message="The VPS restarted before this transfer completed; the previous database was preserved.",
                    completedAt=now,
                )
        elif status not in {"failed", "succeeded", "cancelled"}:
            update_job(
                transfer_id,
                status="failed",
                phase="failed",
                message="The VPS restarted before this transfer completed; the previous database was preserved.",
                completedAt=datetime.now(timezone.utc).isoformat(),
            )
    except (ApiError, OSError, subprocess.SubprocessError):
        if was_active:
            update_job(
                transfer_id,
                status="failed",
                phase="failed",
                message="The VPS restarted during database replacement; inspect this database before retrying.",
                completedAt=datetime.now(timezone.utc).isoformat(),
            )


def initialize_transfer_jobs() -> None:
    """Load transfer metadata on startup, recovering interrupted imports and cleaning work dirs."""
    transfer_dir = _config.cfg("TRANSFER_DIR")
    transfer_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(transfer_dir, 0o700)
    jobs = _config.resolve("transfer_jobs", transfer_jobs)
    recover_import = _config.resolve("_recover_import_database", _recover_import_database)
    update_job = _config.resolve("_update_transfer_job", _update_transfer_job)

    for path in transfer_dir.glob("[0-9a-f]" * 32 + ".json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(job, dict):
            continue
        jobs[str(job.get("transferId", ""))] = job
        was_active = job.get("status") in {"queued", "running", "cancelling"}
        if job.get("direction") == "import":
            recover_import(job, was_active)
        elif was_active:
            update_job(
                str(job.get("transferId", "")),
                status="failed",
                phase="failed",
                message="The VPS restarted before this transfer completed.",
                completedAt=datetime.now(timezone.utc).isoformat(),
            )
    for path in transfer_dir.iterdir():
        if path.is_dir() and TRANSFER_JOB_PATTERN.fullmatch(path.name):
            shutil.rmtree(path, ignore_errors=True)
