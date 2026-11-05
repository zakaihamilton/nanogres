"""Exercise recovery safety against temporary files and mocked PostgreSQL."""
import importlib.util
import json
import http.client
import os
import re
import socket
import threading
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("nanogres_api", Path(__file__).resolve().parents[1] / "vps-api/api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
TEST_ORGANIZATION_ID = "test-org"


class OffsiteBackupFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)

    def test_reports_fresh_verified_copy(self):
        status = api.calculate_offsite_backup_status(
            {"lastSuccessAt": (self.now - timedelta(hours=2)).isoformat()},
            configured=True,
            now=self.now,
        )
        self.assertEqual(status["freshness"], "fresh")
        self.assertEqual(status["lastSuccessAgeSeconds"], 7200)

    def test_reports_stale_copy_after_the_daily_backup_window(self):
        status = api.calculate_offsite_backup_status(
            {"lastSuccessAt": (self.now - timedelta(hours=37)).isoformat()},
            configured=True,
            now=self.now,
        )
        self.assertEqual(status["freshness"], "stale")

    def test_latest_failed_attempt_overrides_a_recent_success(self):
        status = api.calculate_offsite_backup_status(
            {
                "lastSuccessAt": (self.now - timedelta(hours=1)).isoformat(),
                "lastAttemptAt": self.now.isoformat(),
                "lastError": "Upload or remote size verification failed.",
            },
            configured=True,
            now=self.now,
        )
        self.assertEqual(status["freshness"], "error")
        self.assertEqual(status["lastError"], "Upload or remote size verification failed.")

    def test_unconfigured_storage_does_not_expose_saved_error(self):
        status = api.calculate_offsite_backup_status(
            {"lastError": "private error"}, configured=False, now=self.now
        )
        self.assertEqual(status["freshness"], "not-configured")
        self.assertIsNone(status["lastError"])


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for name, value in {"STATE_DIR": root, "RESTORE_UPLOAD_DIR": root / "uploads", "BACKUP_DIR": root / "backups", "EVENTS_FILE": root / "events.jsonl", "TRANSFER_CHUNK_BYTES": 4, "RESTORE_UPLOAD_DISK_RESERVE_BYTES": 0}.items():
            patcher = patch.object(api, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        api.BACKUP_DIR.mkdir()
        self.backup_dir = api.organization_backup_dir(TEST_ORGANIZATION_ID)
        self.backup_dir.mkdir()

    def test_upload_validates_chunks_and_refuses_incomplete_restore(self):
        upload = api.create_restore_upload({"sizeBytes": 6}, TEST_ORGANIZATION_ID)
        upload_id = upload["uploadId"]
        self.assertEqual(upload["chunkCount"], 2)
        with self.assertRaises(api.ApiError):
            api.store_restore_chunk(upload_id, 0, b"bad", TEST_ORGANIZATION_ID)
        api.store_restore_chunk(upload_id, 0, b"abcd", TEST_ORGANIZATION_ID)
        with patch.object(api, "run_sql") as sql, patch.object(
            api,
            "ensure_organization_query_role",
            return_value=api.organization_query_role(TEST_ORGANIZATION_ID),
        ):
            with self.assertRaises(api.ApiError) as error:
                api.restore_uploaded_dump(upload_id, "new_db", None, TEST_ORGANIZATION_ID)
            self.assertEqual(error.exception.status, 400)
            sql.assert_not_called()
        api.store_restore_chunk(upload_id, 1, b"ef", TEST_ORGANIZATION_ID)
        with self.assertRaises(api.ApiError):
            api.store_restore_chunk(upload_id, 2, b"x", TEST_ORGANIZATION_ID)

    def test_restore_rejects_existing_database_without_modifying_it(self):
        name = "app__20261104T120000000000Z.dump"
        (self.backup_dir / name).write_bytes(b"dump")
        with patch.object(api, "run_sql", return_value="t") as sql, patch.object(api, "ensure_organization_query_role", return_value=api.organization_query_role(TEST_ORGANIZATION_ID)), patch.object(api.subprocess, "run") as restore:
            with self.assertRaises(api.ApiError) as error:
                api.restore_backup(TEST_ORGANIZATION_ID, name, "existing")
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(sql.call_count, 1)
            restore.assert_not_called()

    def test_failed_restore_removes_new_database(self):
        name = "app__20261104T120000000000Z.dump"
        (self.backup_dir / name).write_bytes(b"dump")
        physical_database = api.organization_database_name(TEST_ORGANIZATION_ID, "new_db")
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": "x" * 32}), patch.object(api, "run_sql", side_effect=["f", "", ""]) as sql, patch.object(api, "ensure_organization_query_role", return_value=api.organization_query_role(TEST_ORGANIZATION_ID)), patch.object(api, "prepare_organization_database"), patch.object(api, "clear_database_quota_setting"), patch.object(api, "request_quota_reconcile"), patch.object(api.subprocess, "run", return_value=type("Result", (), {"returncode": 1})()):
            with self.assertRaises(api.ApiError) as error:
                api.restore_backup(TEST_ORGANIZATION_ID, name, "new_db")
            self.assertEqual(error.exception.status, 503)
            self.assertIn(f'DROP DATABASE "{physical_database}"', sql.call_args_list[-1].args[0])

    def test_successful_upload_restore_cleans_chunks_and_records_actor(self):
        upload_id = api.create_restore_upload({"sizeBytes": 3}, TEST_ORGANIZATION_ID)["uploadId"]
        api.store_restore_chunk(upload_id, 0, b"abc", TEST_ORGANIZATION_ID)
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": "x" * 32}), patch.object(api, "run_sql", side_effect=["f", ""]), patch.object(api, "ensure_organization_query_role", return_value=api.organization_query_role(TEST_ORGANIZATION_ID)), patch.object(api, "prepare_organization_database"), patch.object(api, "transfer_database_objects"), patch.object(api, "clear_database_quota_setting"), patch.object(api, "request_quota_reconcile"), patch.object(api, "run_pg_restore_from_upload", return_value=0):
            result = api.restore_uploaded_dump(upload_id, "new_db", "actor-1", TEST_ORGANIZATION_ID)
        self.assertEqual(result["database"], "new_db")
        self.assertFalse((api.RESTORE_UPLOAD_DIR / upload_id).exists())
        event = json.loads(api.EVENTS_FILE.read_text())
        self.assertEqual((event["action"], event["actor"]), ("backup.restored", "actor-1"))

    def test_invalid_names_and_paths_are_rejected(self):
        for filename in ["../secret.dump", "app.dump", "app__20261104T120000000000Z.dump/extra"]:
            with self.subTest(filename=filename), self.assertRaises(api.ApiError):
                api.restore_backup(TEST_ORGANIZATION_ID, filename, "new_db")
        for size in [0, -1, True, "4"]:
            with self.subTest(size=size), self.assertRaises(api.ApiError):
                api.create_restore_upload({"sizeBytes": size}, TEST_ORGANIZATION_ID)


class DatabaseTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.transfer_dir = self.root / "transfers"
        self.transfer_dir.mkdir(mode=0o700)
        self.patcher = patch.object(api, "TRANSFER_DIR", self.transfer_dir)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        api.transfer_jobs.clear()
        api.transfer_workers.clear()
        api.transfer_processes.clear()
        api.transfer_cancel_events.clear()

    def test_external_url_is_pinned_to_public_tls_host_and_password_file_is_private(self):
        work_dir = self.transfer_dir / "job"
        work_dir.mkdir(mode=0o700)
        address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 5432))
        with patch.object(api.socket, "getaddrinfo", return_value=[address]):
            conninfo, env = api._external_connection(
                "postgresql://migrate:s%3Acret@db.example:6543/visitoring?sslmode=disable",
                work_dir,
            )
        self.assertIn("hostaddr='8.8.8.8'", conninfo)
        self.assertIn("sslmode='verify-full'", conninfo)
        self.assertNotIn("secret", conninfo)
        passfile = Path(env["PGPASSFILE"])
        self.assertEqual(passfile.stat().st_mode & 0o777, 0o600)
        self.assertIn(r"s\:cret", passfile.read_text())

    def test_external_url_rejects_private_addresses_and_libpq_options(self):
        work_dir = self.transfer_dir / "job"
        work_dir.mkdir(mode=0o700)
        loopback = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 5432))
        with patch.object(api.socket, "getaddrinfo", return_value=[loopback]):
            with self.assertRaises(api.ApiError):
                api._external_connection("postgres://user:secret@db.example/app", work_dir)
        with patch.object(api.socket, "getaddrinfo", return_value=[loopback]):
            with self.assertRaises(api.ApiError):
                api._external_connection(
                    "postgres://user:secret@db.example/app?options=-c%20search_path%3Dpublic",
                    work_dir,
                )

    def test_connection_string_is_not_written_to_job_metadata_or_public_job(self):
        secret = "postgresql://migrate:do-not-persist@db.example/visitoring"
        with patch.object(api, "_run_transfer_job") as worker:
            job = api.create_transfer_job(
                {
                    "direction": "import",
                    "targetMode": "new",
                    "targetDatabase": "visitoring",
                    "connectionString": secret,
                },
                TEST_ORGANIZATION_ID,
                "user-1",
            )
            api.transfer_workers[job["transferId"]].join(timeout=2)
        serialized = Path(self.transfer_dir, job["transferId"] + ".json").read_text()
        self.assertTrue(worker.called)
        self.assertNotIn(secret, serialized)
        self.assertNotIn("do-not-persist", str(job))
        self.assertNotIn("connectionString", serialized)

    def test_worker_error_does_not_expose_postgres_client_stderr(self):
        transfer_id = "a" * 32
        api.transfer_cancel_events[transfer_id] = threading.Event()
        api.transfer_jobs[transfer_id] = {
            "transferId": transfer_id,
            "organizationPrefix": api.organization_prefix(TEST_ORGANIZATION_ID),
            "status": "running",
        }

        class FailedProcess:
            returncode = 1

            def communicate(self, timeout=None):
                return "", "authentication failed for password secret-value"

        with patch.object(api.subprocess, "Popen", return_value=FailedProcess()):
            with self.assertRaises(api.ApiError) as error:
                api._transfer_command(transfer_id, "dumping", ["pg_dump"], {})
        self.assertNotIn("secret-value", error.exception.message)
        self.assertEqual(error.exception.status, 400)
        self.assertIn("Check credentials", error.exception.message)

    def test_newer_remote_server_version_has_a_clear_error(self):
        transfer_id = "e" * 32
        api.transfer_cancel_events[transfer_id] = threading.Event()
        api.transfer_jobs[transfer_id] = {
            "transferId": transfer_id,
            "organizationPrefix": api.organization_prefix(TEST_ORGANIZATION_ID),
            "status": "running",
        }

        class FailedProcess:
            returncode = 1

            def communicate(self, timeout=None):
                return "", "server version: 17.4; pg_dump version: 16.8"

        with patch.object(api.subprocess, "Popen", return_value=FailedProcess()):
            with self.assertRaises(api.ApiError) as error:
                api._transfer_command(transfer_id, "dumping", ["pg_dump"], {})
        self.assertEqual(error.exception.status, 400)
        self.assertIn("do not support that database version", error.exception.message)

    def test_transfer_job_status_is_scoped_to_organization(self):
        job = {
            "transferId": "b" * 32,
            "organizationPrefix": api.organization_prefix(TEST_ORGANIZATION_ID),
            "direction": "import",
            "status": "running",
            "phase": "dumping_external_database",
            "message": "Dumping external database",
            "sourceDatabase": "external PostgreSQL",
            "targetDatabase": "visitoring",
        }
        api.transfer_jobs[job["transferId"]] = job
        api._write_transfer_metadata(job)
        with self.assertRaises(api.ApiError) as error:
            api._load_transfer_job(job["transferId"], "another-org")
        self.assertEqual(error.exception.status, 404)
        self.assertEqual(len(api.list_transfer_jobs(TEST_ORGANIZATION_ID)), 1)

    def test_transfer_cannot_be_cancelled_during_database_swap(self):
        transfer_id = "2" * 32
        job = {
            "transferId": transfer_id,
            "organizationPrefix": api.organization_prefix(TEST_ORGANIZATION_ID),
            "status": "running",
            "phase": "finalizing_database",
            "swapStarted": True,
        }
        api.transfer_jobs[transfer_id] = job
        api.transfer_cancel_events[transfer_id] = threading.Event()
        api._write_transfer_metadata(job)
        with self.assertRaises(api.ApiError) as error:
            api.cancel_transfer_job(transfer_id, TEST_ORGANIZATION_ID)
        self.assertEqual(error.exception.status, 409)
        self.assertFalse(api.transfer_cancel_events[transfer_id].is_set())

    def test_startup_recovery_completes_a_swap_that_finished_before_restart(self):
        transfer_id = "f" * 32
        prefix = api.organization_prefix(TEST_ORGANIZATION_ID)
        target = api.organization_database_name(TEST_ORGANIZATION_ID, "visitoring")
        backup = prefix + "transfer_old_" + transfer_id[:24]
        names = {target, backup}
        job = {
            "transferId": transfer_id,
            "organizationPrefix": prefix,
            "organizationId": TEST_ORGANIZATION_ID,
            "direction": "import",
            "targetMode": "replace",
            "targetDatabase": "visitoring",
            "swapStarted": True,
            "swapAttempted": True,
            "status": "running",
            "phase": "finalizing_database",
        }
        api.transfer_jobs[transfer_id] = job
        api._write_transfer_metadata(job)

        def run_sql(statement, database="postgres"):
            if statement.startswith("SELECT EXISTS"):
                name = re.search(r"datname = '([^']+)'", statement).group(1)
                return "t" if name in names else "f"
            alter = re.search(r'ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"', statement)
            if alter:
                names.remove(alter.group(1))
                names.add(alter.group(2))
            drop = re.search(r'DROP DATABASE "([^"]+)"', statement)
            if drop:
                names.discard(drop.group(1))
            return ""

        with patch.object(api, "run_sql", side_effect=run_sql), patch.object(api, "record_event"):
            api._recover_import_database(job, was_active=True)
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(names, {target})

    def test_startup_recovery_restores_old_database_when_swap_was_interrupted(self):
        transfer_id = "1" * 32
        prefix = api.organization_prefix(TEST_ORGANIZATION_ID)
        target = api.organization_database_name(TEST_ORGANIZATION_ID, "visitoring")
        staging = prefix + "transfer_" + transfer_id[:24]
        backup = prefix + "transfer_old_" + transfer_id[:24]
        names = {staging, backup}
        job = {
            "transferId": transfer_id,
            "organizationPrefix": prefix,
            "organizationId": TEST_ORGANIZATION_ID,
            "direction": "import",
            "targetMode": "replace",
            "targetDatabase": "visitoring",
            "swapStarted": True,
            "oldDatabaseRenamed": True,
            "status": "running",
            "phase": "finalizing_database",
        }
        api.transfer_jobs[transfer_id] = job
        api._write_transfer_metadata(job)

        def run_sql(statement, database="postgres"):
            if statement.startswith("SELECT EXISTS"):
                name = re.search(r"datname = '([^']+)'", statement).group(1)
                return "t" if name in names else "f"
            alter = re.search(r'ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"', statement)
            if alter:
                names.remove(alter.group(1))
                names.add(alter.group(2))
            drop = re.search(r'DROP DATABASE "([^"]+)"', statement)
            if drop:
                names.discard(drop.group(1))
            return ""

        with patch.object(api, "run_sql", side_effect=run_sql):
            api._recover_import_database(job, was_active=True)
        self.assertEqual(job["status"], "failed")
        self.assertIn("previous database was preserved", job["message"])
        self.assertEqual(names, {target})

    def _export_job(self, mode):
        transfer_id = "d" * 32
        work_dir = self.transfer_dir / transfer_id
        work_dir.mkdir(mode=0o700)
        job = {
            "transferId": transfer_id,
            "organizationPrefix": api.organization_prefix(TEST_ORGANIZATION_ID),
            "organizationId": TEST_ORGANIZATION_ID,
            "actor": "user-1",
            "direction": "export",
            "targetMode": mode,
            "sourceDatabase": "visitoring",
            "targetDatabase": "external PostgreSQL",
            "status": "running",
        }
        api.transfer_jobs[transfer_id] = job
        api.transfer_cancel_events[transfer_id] = threading.Event()
        return transfer_id, job, work_dir

    def test_export_requires_empty_external_database_before_restore(self):
        transfer_id, job, work_dir = self._export_job("empty")
        phases = []

        def run_command(_transfer_id, phase, command, _env, **_kwargs):
            phases.append(phase)
            if "--file" in command:
                Path(command[command.index("--file") + 1]).write_bytes(b"dump")
            if phase == "checking_external_database":
                return "t"
            return ""

        with patch.object(api, "require_organization_database", return_value="physical_db"), \
                patch.object(api, "_external_connection", return_value=("conninfo", {})), \
                patch.object(api, "_transfer_command", side_effect=run_command):
            with self.assertRaises(api.ApiError) as error:
                api._export_transfer(transfer_id, job, "postgres://user:secret@public.example/app", work_dir)
        self.assertEqual(error.exception.status, 409)
        self.assertNotIn("restoring_external_database", phases)

    def test_external_replace_clears_and_restores_in_one_transaction(self):
        transfer_id = "3" * 32
        work_dir = self.transfer_dir / transfer_id
        work_dir.mkdir(mode=0o700)
        archive = work_dir / "database.dump"
        archive.write_bytes(b"custom archive")
        api.transfer_jobs[transfer_id] = {
            "transferId": transfer_id,
            "organizationPrefix": api.organization_prefix(TEST_ORGANIZATION_ID),
            "status": "running",
        }
        api.transfer_cancel_events[transfer_id] = threading.Event()
        commands = []

        def run_command(_transfer_id, phase, command, _env, **_kwargs):
            commands.append((phase, command))
            file_index = command.index("--file") + 1
            if phase == "preparing_external_restore":
                Path(command[file_index]).write_text("CREATE TABLE public.visits (id integer);\n")
            if phase == "restoring_external_database":
                script = Path(command[file_index]).read_text()
                self.assertIn("DROP SCHEMA", script)
                self.assertIn("CREATE TABLE public.visits", script)
                self.assertIn("--single-transaction", command)
            return ""

        with patch.object(api, "_transfer_command", side_effect=run_command):
            api._restore_external_archive(
                transfer_id,
                "host='db.example'",
                {},
                archive,
                work_dir,
                phase="restoring_external_database",
                clear_first=True,
                include_acls=False,
            )
        self.assertEqual([phase for phase, _command in commands], ["preparing_external_restore", "restoring_external_database"])

    def test_replace_export_restores_rollback_copy_when_destination_restore_fails(self):
        transfer_id, job, work_dir = self._export_job("replace")
        phases = []

        def run_command(_transfer_id, phase, command, _env, **_kwargs):
            phases.append(phase)
            if "--file" in command:
                Path(command[command.index("--file") + 1]).write_bytes(b"dump")
            if phase == "restoring_external_database":
                raise api.ApiError(503, "PostgreSQL could not complete the transfer step.")
            return ""

        with patch.object(api, "require_organization_database", return_value="physical_db"), \
                patch.object(api, "_external_connection", return_value=("conninfo", {})), \
                patch.object(api, "_transfer_command", side_effect=run_command):
            with self.assertRaises(api.ApiError) as error:
                api._export_transfer(transfer_id, job, "postgres://user:secret@public.example/app", work_dir)
        self.assertEqual(error.exception.status, 503)
        self.assertIn("preparing_external_restore", phases)
        self.assertIn("restoring_external_rollback_copy", phases)
        self.assertFalse(job.get("recoveryBackupRetained"))

    def test_failed_external_rollback_retains_only_the_recovery_dump(self):
        transfer_id, job, work_dir = self._export_job("replace")
        (work_dir / "pgpass").write_text("private connection secret")

        def run_command(_transfer_id, phase, command, _env, **_kwargs):
            if "--file" in command:
                Path(command[command.index("--file") + 1]).write_bytes(b"dump")
            if phase in {"restoring_external_database", "restoring_external_rollback_copy"}:
                raise api.ApiError(503, "PostgreSQL could not complete the transfer step.")
            return ""

        with patch.object(api, "require_organization_database", return_value="physical_db"), \
                patch.object(api, "_external_connection", return_value=("conninfo", {})), \
                patch.object(api, "_transfer_command", side_effect=run_command):
            api._run_transfer_job(transfer_id, "postgres://user:secret@public.example/app")
        self.assertIn("recovery copy remains", str(api.transfer_jobs[transfer_id]["message"]))
        self.assertTrue(job["recoveryBackupRetained"])
        self.assertTrue((self.transfer_dir / f"{transfer_id}.recovery.dump").is_file())
        self.assertFalse(work_dir.exists())
        self.assertNotIn("private connection secret", (self.transfer_dir / f"{transfer_id}.recovery.dump").read_text())


class HttpAuthorizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = api.ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_token_required_and_misconfiguration_fails_closed(self):
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": "short"}):
            self.assertEqual(self.request("GET", "/v1/roles")[0], 503)
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": "x" * 32}), patch.object(api, "list_roles", return_value=[]):
            self.assertEqual(self.request("GET", "/v1/roles")[0], 401)
            self.assertEqual(self.request("GET", "/v1/roles", headers={"Authorization": "Bearer " + "y" * 32})[0], 401)
            self.assertEqual(self.request("GET", "/v1/roles", headers={"Authorization": "Bearer " + "x" * 32, "X-Nanogres-Organization": TEST_ORGANIZATION_ID}), (200, {"roles": []}))

    def test_database_creation_uses_authenticated_actor(self):
        headers = {"Authorization": "Bearer " + "x" * 32, "Content-Type": "application/json", "X-Nanogres-Actor": "user-1", "X-Nanogres-Organization": TEST_ORGANIZATION_ID}
        physical_database = api.organization_database_name(TEST_ORGANIZATION_ID, "app")
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": "x" * 32}), patch.object(api, "run_sql", side_effect=["f", ""]) as sql, patch.object(api, "ensure_organization_query_role", return_value=api.organization_query_role(TEST_ORGANIZATION_ID)), patch.object(api, "prepare_organization_database"), patch.object(api, "clear_database_quota_setting"), patch.object(api, "request_quota_reconcile"), patch.object(api, "record_event") as event, patch.object(api, "postgres_status", return_value={"disk": {"freeBytes": 100}}), patch.object(api, "list_databases", return_value=[]), patch.object(api, "add_database_growth_targets", return_value=[{"name": physical_database, "owner": api.organization_query_role(TEST_ORGANIZATION_ID)}]):
            status, payload = self.request("POST", "/v1/databases", json.dumps({"name": "app"}), headers)
            self.assertEqual((status, payload["database"]["name"]), (201, "app"))
            self.assertIn(f'CREATE DATABASE "{physical_database}"', sql.call_args_list[-1].args[0])
            self.assertEqual(event.call_args.args[2], "user-1")

    def test_readonly_role_limits_privileges_and_does_not_log_password(self):
        headers = {"Authorization": "Bearer " + "x" * 32, "Content-Type": "application/json", "X-Nanogres-Actor": "user-1", "X-Nanogres-Organization": TEST_ORGANIZATION_ID}
        body = {"name": "reader", "database": "app", "access": "readonly", "password": "a-strong-password"}
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": "x" * 32}), patch.object(api, "run_sql", side_effect=["t", "f", ""]) as sql, patch.object(api, "ensure_organization_query_role", return_value=api.organization_query_role(TEST_ORGANIZATION_ID)), patch.object(api, "record_event") as event:
            status, payload = self.request("POST", "/v1/roles", json.dumps(body), headers)
            self.assertEqual((status, payload["role"]["access"]), (201, "readonly"))
            statement = sql.call_args_list[-1].args[0]
            self.assertIn("GRANT SELECT ON ALL TABLES", statement)
            self.assertNotIn("INSERT", statement)
            self.assertNotIn(body["password"], str(event.call_args))

    def test_post_rejects_invalid_content_and_does_not_execute_action(self):
        headers = {"Authorization": "Bearer " + "x" * 32, "X-Nanogres-Organization": TEST_ORGANIZATION_ID}
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": "x" * 32}), patch.object(api, "run_sql") as sql:
            self.assertEqual(self.request("POST", "/v1/databases", body="{}", headers=headers)[0], 415)
            headers["Content-Type"] = "application/json"
            self.assertEqual(self.request("POST", "/v1/databases", body="{", headers=headers)[0], 400)
            self.assertEqual(self.request("POST", "/v1/databases", body="[]", headers=headers)[0], 400)
            self.assertEqual(self.request("POST", "/v1/databases", body=json.dumps({"name": "INVALID"}), headers=headers)[0], 400)
            sql.assert_not_called()

    def test_transfer_routes_require_authorization_and_keep_the_connection_out_of_responses(self):
        token = "x" * 32
        headers = {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "X-Nanogres-Actor": "user-1",
            "X-Nanogres-Organization": TEST_ORGANIZATION_ID,
        }
        transfer_id = "c" * 32
        public_job = {
            "transferId": transfer_id,
            "direction": "import",
            "status": "queued",
            "phase": "queued",
            "message": "Waiting to start",
            "sourceDatabase": "external PostgreSQL",
            "targetDatabase": "visitoring",
        }
        body = {
            "direction": "import",
            "targetMode": "new",
            "targetDatabase": "visitoring",
            "connectionString": "postgresql://user:private-secret@db.example/visitoring",
        }
        with patch.dict(os.environ, {"NANOGRES_API_TOKEN": token}), \
                patch.object(api, "list_transfer_jobs", return_value=[public_job]), \
                patch.object(api, "create_transfer_job", return_value=public_job), \
                patch.object(api, "cancel_transfer_job", return_value={**public_job, "status": "cancelling"}) as cancel:
            self.assertEqual(self.request("GET", "/v1/transfers")[0], 401)
            status, payload = self.request("GET", "/v1/transfers", headers=headers)
            self.assertEqual((status, payload["transfers"][0]["transferId"]), (200, transfer_id))
            status, payload = self.request("POST", "/v1/transfers", json.dumps(body), headers)
            self.assertEqual((status, payload["transfer"]["status"]), (202, "queued"))
            self.assertNotIn("private-secret", json.dumps(payload))
            status, payload = self.request("DELETE", f"/v1/transfers/{transfer_id}", headers=headers)
            self.assertEqual((status, payload["transfer"]["status"]), (200, "cancelling"))
            cancel.assert_called_once_with(transfer_id, TEST_ORGANIZATION_ID)


if __name__ == "__main__":
    unittest.main()
