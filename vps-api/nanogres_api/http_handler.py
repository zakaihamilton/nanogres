"""Private HTTP control-plane handler routing requests to Nanogres domain modules."""

from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import subprocess
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlsplit

from . import backups as _backups
from . import config as _config
from . import pg as _pg
from . import quotas_offsite as _quotas_offsite
from . import sql_studio as _sql_studio
from . import tenants as _tenants
from . import transfers as _transfers
from . import workload_identity as _workload_identity
from .config import ACTOR_PATTERN, ApiError, backup_lock


class Handler(BaseHTTPRequestHandler):
    """HTTP request handler for the local Nanogres control API."""

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
            return _config.resolve(
                "normalized_organization_id", _tenants.normalized_organization_id
            )(self.headers.get("X-Nanogres-Organization", ""))
        except ApiError as error:
            self._json(error.status, {"error": error.message})
            return None

    def _body(self, max_length: int = 8192) -> dict[str, object]:
        if (
            self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            != "application/json"
        ):
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

    @staticmethod
    def _extract_database_subresource(path: str, suffix: str) -> str | None:
        if path.startswith("/v1/databases/") and path.endswith(suffix):
            encoded_name = path.removeprefix("/v1/databases/").removesuffix(suffix)
            if "/" in encoded_name:
                raise ApiError(404, "Route not found.")
            return unquote(encoded_name)
        return None

    def _tenant_status_and_databases(
        self, organization_id: str
    ) -> tuple[dict[str, object], list[dict[str, object]]]:
        status = _config.resolve("postgres_status", _pg.postgres_status)()
        databases = _config.resolve(
            "add_database_growth_targets", _quotas_offsite.add_database_growth_targets
        )(
            _config.resolve("list_databases", _tenants.list_databases)(),
            int(status["disk"]["freeBytes"]),
        )
        scoped = _config.resolve("public_tenant_databases", _tenants.public_tenant_databases)(
            organization_id, databases
        )
        return status, scoped

    def _handle_sse_stream(self, organization_id: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        pg_status_fn = _config.resolve("postgres_status", _pg.postgres_status)
        list_activity_fn = _config.resolve("list_activity", _tenants.list_activity)
        while True:
            try:
                status = pg_status_fn()
                payload = {
                    "type": "telemetry",
                    "status": status,
                    "activity": list_activity_fn(organization_id, 6),
                    "timestamp": time.time(),
                }
                self.wfile.write(
                    f"event: telemetry\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
                )
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            time.sleep(5)

    def _handle_query_post(self, organization_id: str, actor: str | None) -> None:
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
        result = _config.resolve("run_user_query", _sql_studio.run_user_query)(
            sql,
            organization_id=organization_id,
            database=db,
            read_only=read_only,
            timeout_seconds=timeout,
            max_rows=max_rows,
            actor=actor,
        )
        _config.resolve("record_event", _tenants.record_event)(
            "query.executed", f"Query executed on {db}.", actor, organization_id
        )
        self._json(200, result)

    def do_GET(self) -> None:
        """Handle GET API requests and SSE telemetry streams."""
        if not self._authorized():
            return
        try:
            path = urlsplit(self.path).path
            if path == "/healthz":
                status = _config.resolve("postgres_status", _pg.postgres_status)()
                self._json(200, {"ok": True, **status})
                return
            organization_id = self._organization()
            if organization_id is None:
                return
            if path == "/v1/overview":
                status, scoped_databases = self._tenant_status_and_databases(organization_id)
                self._json(
                    200,
                    {
                        "status": status,
                        "databases": scoped_databases,
                        "backups": _config.resolve("list_backups", _backups.list_backups)(
                            organization_id
                        )[:8],
                        "activity": _config.resolve("list_activity", _tenants.list_activity)(
                            organization_id, 8
                        ),
                    },
                )
            elif path == "/v1/databases":
                status, scoped_databases = self._tenant_status_and_databases(organization_id)
                self._json(200, {"status": status, "databases": scoped_databases})
            elif path == "/v1/roles":
                self._json(
                    200,
                    {"roles": _config.resolve("list_roles", _tenants.list_roles)(organization_id)},
                )
            elif path == "/v1/workload-identities":
                self._json(
                    200,
                    {
                        "identities": _config.resolve(
                            "list_workload_identities",
                            _workload_identity.list_workload_identities,
                        )(organization_id)
                    },
                )
            elif path == "/v1/backups":
                self._json(
                    200,
                    {
                        "backups": _config.resolve("list_backups", _backups.list_backups)(
                            organization_id
                        )
                    },
                )
            elif path == "/v1/transfers":
                self._json(
                    200,
                    {
                        "transfers": _config.resolve(
                            "list_transfer_jobs", _transfers.list_transfer_jobs
                        )(organization_id)
                    },
                )
            elif re.fullmatch(r"/v1/transfers/[a-f0-9]{32}", path):
                transfer_id = path.removeprefix("/v1/transfers/")
                job = _config.resolve("_load_transfer_job", _transfers._load_transfer_job)(
                    transfer_id, organization_id
                )
                public_job = _config.resolve(
                    "_public_transfer_job", _transfers._public_transfer_job
                )(job)
                self._json(200, {"transfer": public_job})
            elif path == "/v1/activity":
                self._json(
                    200,
                    {
                        "events": _config.resolve("list_activity", _tenants.list_activity)(
                            organization_id
                        )
                    },
                )
            elif path == "/v1/activity/queries":
                self._json(
                    200,
                    {
                        "queries": _config.resolve(
                            "get_active_queries", _sql_studio.get_active_queries
                        )(organization_id)
                    },
                )
            elif (db_name := self._extract_database_subresource(path, "/extensions")) is not None:
                self._json(
                    200,
                    _config.resolve(
                        "get_database_extensions", _sql_studio.get_database_extensions
                    )(organization_id, db_name),
                )
            elif (db_name := self._extract_database_subresource(path, "/schema")) is not None:
                database = _config.resolve(
                    "require_organization_database", _tenants.require_organization_database
                )(organization_id, db_name)
                self._json(
                    200,
                    _config.resolve("get_database_schema", _sql_studio.get_database_schema)(
                        database
                    ),
                )
            elif (db_name := self._extract_database_subresource(path, "/queries")) is not None:
                self._json(
                    200,
                    {
                        "queries": _config.resolve(
                            "get_active_queries", _sql_studio.get_active_queries
                        )(organization_id, db_name)
                    },
                )
            elif path == "/v1/events/stream":
                self._handle_sse_stream(organization_id)
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
        """Handle POST API requests across control-plane resources."""
        if not self._authorized():
            return
        try:
            path = urlsplit(self.path).path
            organization_id = self._organization()
            if organization_id is None:
                return
            actor = self._actor()
            if path == "/v1/query":
                self._handle_query_post(organization_id, actor)
                return

            body = self._body(max_length=16384 if path == "/v1/transfers" else 8192)
            if path == "/v1/databases":
                database_row = _config.resolve("create_database", _tenants.create_database)(
                    organization_id, body, actor
                )
                self._json(201, {"database": database_row})
            elif (db_name := self._extract_database_subresource(path, "/extensions")) is not None:
                self._json(
                    200,
                    _config.resolve(
                        "update_database_extension", _sql_studio.update_database_extension
                    )(organization_id, db_name, body, actor),
                )
            elif (db_name := self._extract_database_subresource(path, "/quota")) is not None:
                database = _config.resolve(
                    "update_database_quota", _quotas_offsite.update_database_quota
                )(organization_id, db_name, body, actor)
                self._json(200, {"database": database})
            elif path == "/v1/roles":
                self._create_role(body, actor, organization_id)
            elif path == "/v1/workload-identities":
                identity = _config.resolve(
                    "create_workload_identity", _workload_identity.create_workload_identity
                )(body, actor, organization_id)
                self._json(201, {"identity": identity})
            elif path == "/v1/workload-certificates":
                cert = _config.resolve(
                    "issue_workload_certificate", _workload_identity.issue_workload_certificate
                )(body, organization_id)
                self._json(201, cert)
            elif path == "/v1/backups":
                database = str(body.get("database", ""))
                with backup_lock:
                    backup = _config.resolve("create_backup", _backups.create_backup)(
                        organization_id,
                        database,
                        actor,
                        timeout_seconds=240,
                    )
                self._json(201, {"backup": backup})
            elif path == "/v1/transfers":
                transfer = _config.resolve("create_transfer_job", _transfers.create_transfer_job)(
                    body, organization_id, actor
                )
                self._json(202, {"transfer": transfer})
            elif path.startswith("/v1/backups/") and path.endswith("/restore"):
                encoded_name = path.removeprefix("/v1/backups/").removesuffix("/restore")
                restored = _config.resolve("restore_backup", _backups.restore_backup)(
                    organization_id,
                    encoded_name,
                    body.get("database"),
                    actor,
                )
                self._json(201, restored)
            elif path == "/v1/restore-uploads":
                upload = _config.resolve(
                    "create_restore_upload", _backups.create_restore_upload
                )(body, organization_id)
                self._json(201, upload)
            elif path.startswith("/v1/restore-uploads/") and path.endswith("/complete"):
                upload_id = path.removeprefix("/v1/restore-uploads/").removesuffix("/complete")
                restored = _config.resolve(
                    "restore_uploaded_dump", _backups.restore_uploaded_dump
                )(
                    upload_id,
                    body.get("database"),
                    actor,
                    organization_id,
                )
                self._json(201, restored)
            elif (db_name := self._extract_database_subresource(path, "/ddl")) is not None:
                database = _config.resolve(
                    "require_organization_database", _tenants.require_organization_database
                )(organization_id, db_name)
                res = _config.resolve("execute_ddl", _sql_studio.execute_ddl)(
                    database, body, actor, organization_id
                )
                self._json(200, res)
            elif path.startswith("/v1/activity/queries/") and path.endswith("/terminate"):
                pid_str = path.removeprefix("/v1/activity/queries/").removesuffix("/terminate")
                if not pid_str.isdigit():
                    raise ApiError(400, "Invalid process ID.")
                signal = str(body.get("action", "cancel"))
                res = _config.resolve("terminate_query", _sql_studio.terminate_query)(
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
        """Handle PUT requests for chunked restore uploads."""
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
            if (
                self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                != "application/octet-stream"
            ):
                raise ApiError(415, "Content-Type must be application/octet-stream.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as error:
                raise ApiError(400, "Invalid upload chunk.") from error
            if length <= 0 or length > _config.cfg("TRANSFER_CHUNK_BYTES"):
                raise ApiError(413, "Upload chunk is too large.")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ApiError(400, "Upload chunk was incomplete.")
            result = _config.resolve("store_restore_chunk", _backups.store_restore_chunk)(
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
        """Handle DELETE requests for transfers, workload identities, uploads, and databases."""
        if not self._authorized():
            return
        try:
            organization_id = self._organization()
            if organization_id is None:
                return
            path = urlsplit(self.path).path
            transfer_match = re.fullmatch(r"/v1/transfers/([a-f0-9]{32})", path)
            if transfer_match:
                transfer = _config.resolve("cancel_transfer_job", _transfers.cancel_transfer_job)(
                    transfer_match.group(1), organization_id
                )
                self._json(200, {"transfer": transfer})
                return
            identity_match = re.fullmatch(r"/v1/workload-identities/([a-f0-9]{32})", path)
            if identity_match:
                _config.resolve(
                    "delete_workload_identity", _workload_identity.delete_workload_identity
                )(identity_match.group(1), organization_id)
                self._json(200, {"deleted": True})
                return
            upload_prefix = "/v1/restore-uploads/"
            if path.startswith(upload_prefix):
                upload_id = path.removeprefix(upload_prefix)
                upload_path, _metadata = _config.resolve(
                    "read_restore_upload", _backups.read_restore_upload
                )(upload_id, organization_id)
                shutil.rmtree(upload_path)
                self._json(200, {"deleted": True})
                return
            prefix = "/v1/databases/"
            if not path.startswith(prefix):
                self._json(404, {"error": "Route not found."})
                return
            logical_name = unquote(path.removeprefix(prefix))
            result = _config.resolve("delete_database", _tenants.delete_database)(
                organization_id, logical_name, self._actor()
            )
            self._json(200, result)
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
        result = _config.resolve("create_role", _tenants.create_role)(
            body, actor, organization_id
        )
        self._json(201, result)

    def _download_backup(
        self,
        organization_id: object,
        encoded_name: str,
        query: dict[str, list[str]],
    ) -> None:
        _config.resolve("download_backup", _backups.download_backup)(
            self, organization_id, encoded_name, query
        )
