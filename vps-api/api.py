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
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


API_HOST = os.environ.get("NANOGRES_API_HOST", "127.0.0.1")
API_PORT = int(os.environ.get("NANOGRES_API_PORT", "8765"))
BACKUP_DIR = Path(os.environ.get("NANOGRES_BACKUP_DIR", "/var/backups/nanogres"))
STATE_DIR = Path(os.environ.get("NANOGRES_STATE_DIR", "/var/lib/nanogres"))
EVENTS_FILE = STATE_DIR / "events.jsonl"
BACKUP_RETENTION_DAYS = int(os.environ.get("NANOGRES_BACKUP_RETENTION_DAYS", "14"))
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
BACKUP_PATTERN = re.compile(r"^([a-z][a-z0-9_]*)__([0-9]{8}T[0-9]{12}Z)\.dump$")
ACTOR_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
event_lock = threading.Lock()
backup_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def run_sql(statement: str, database: str = "postgres") -> str:
    if not NAME_PATTERN.fullmatch(database) and database not in {"postgres", "template0", "template1"}:
        raise ApiError(400, "Invalid database name.")
    command = [
        "/usr/bin/psql",
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
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PGCONNECT_TIMEOUT": "5"}
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
          SELECT d.datname AS name,
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
    disk = shutil.disk_usage("/")
    return {
        **status,
        "disk": {"totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
        "backupRetentionDays": BACKUP_RETENTION_DAYS,
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


def create_backup(database: str, actor: str | None = None) -> dict[str, object]:
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
        "/usr/bin/pg_dump",
        "--format=custom",
        "--no-owner",
        "--file",
        str(partial_path),
        "--dbname",
        database,
    ]
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PGCONNECT_TIMEOUT": "10"}
    old_umask = os.umask(0o077)
    try:
        result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=3600)
    except subprocess.TimeoutExpired as error:
        partial_path.unlink(missing_ok=True)
        raise ApiError(504, "Backup exceeded the one hour limit.") from error
    finally:
        os.umask(old_umask)
    if result.returncode:
        partial_path.unlink(missing_ok=True)
        raise ApiError(503, "PostgreSQL could not create the backup.")
    os.chmod(partial_path, 0o600)
    partial_path.replace(final_path)
    cleanup_old_backups()
    record_event("backup.created", f"Backup created for {database}.", actor)
    return {
        "filename": filename,
        "database": database,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sizeBytes": final_path.stat().st_size,
    }


def backup_all() -> int:
    databases = [row["name"] for row in list_databases() if row.get("name") != "postgres"]
    completed = 0
    for database in databases:
        create_backup(str(database))
        completed += 1
    cleanup_old_backups()
    return completed


def valid_name(value: object, label: str) -> str:
    if not isinstance(value, str) or not NAME_PATTERN.fullmatch(value):
        raise ApiError(400, f"{label} must start with a lowercase letter and contain only lowercase letters, numbers, or underscores.")
    return value


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
                self._json(
                    200,
                    {
                        "status": postgres_status(),
                        "databases": list_databases(),
                        "backups": list_backups()[:8],
                        "activity": list_activity(8),
                    },
                )
            elif path == "/v1/databases":
                self._json(200, {"databases": list_databases()})
            elif path == "/v1/roles":
                self._json(200, {"roles": list_roles()})
            elif path == "/v1/backups":
                self._json(200, {"backups": list_backups()})
            elif path == "/v1/activity":
                self._json(200, {"events": list_activity()})
            elif path.startswith("/v1/backups/"):
                self._download_backup(path.removeprefix("/v1/backups/"))
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
                exists = run_sql(
                    f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(name)})"
                )
                if exists == "t":
                    raise ApiError(409, "A database with that name already exists.")
                run_sql(
                    f"CREATE DATABASE {quote_identifier(name)} OWNER postgres ENCODING 'UTF8' TEMPLATE template0"
                )
                record_event("database.created", f"Database {name} created.", actor)
                self._json(201, {"database": next(row for row in list_databases() if row["name"] == name)})
            elif path == "/v1/roles":
                self._create_role(body, actor)
            elif path == "/v1/backups":
                database = valid_name(body.get("database"), "Database name")
                with backup_lock:
                    backup = create_backup(database, actor)
                self._json(201, {"backup": backup})
            else:
                self._json(404, {"error": "Route not found."})
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except StopIteration:
            self._json(201, {"created": True})
        except (OSError, subprocess.SubprocessError):
            self._json(503, {"error": "Nanogres could not complete the operation."})

    def do_DELETE(self) -> None:
        if not self._authorized():
            return
        try:
            path = urlsplit(self.path).path
            prefix = "/v1/databases/"
            if not path.startswith(prefix):
                self._json(404, {"error": "Route not found."})
                return
            name = valid_name(unquote(path.removeprefix(prefix)), "Database name")
            if name in {"postgres", "template0", "template1"}:
                raise ApiError(400, "A default PostgreSQL database cannot be removed.")
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

    def _download_backup(self, encoded_name: str) -> None:
        filename = unquote(encoded_name)
        if not BACKUP_PATTERN.fullmatch(filename):
            raise ApiError(404, "Backup not found.")
        path = BACKUP_DIR / filename
        if not path.is_file() or path.is_symlink():
            raise ApiError(404, "Backup not found.")
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with path.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile, length=1024 * 1024)


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
