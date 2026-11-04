"""Exercise recovery safety against temporary files and mocked PostgreSQL."""
import importlib.util
import json
import http.client
import os
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
        with patch.object(api, "run_sql", side_effect=["f", "", ""]) as sql, patch.object(api, "ensure_organization_query_role", return_value=api.organization_query_role(TEST_ORGANIZATION_ID)), patch.object(api, "prepare_organization_database"), patch.object(api, "clear_database_quota_setting"), patch.object(api, "request_quota_reconcile"), patch.object(api.subprocess, "run", return_value=type("Result", (), {"returncode": 1})()):
            with self.assertRaises(api.ApiError) as error:
                api.restore_backup(TEST_ORGANIZATION_ID, name, "new_db")
            self.assertEqual(error.exception.status, 503)
            self.assertIn(f'DROP DATABASE "{physical_database}"', sql.call_args_list[-1].args[0])

    def test_successful_upload_restore_cleans_chunks_and_records_actor(self):
        upload_id = api.create_restore_upload({"sizeBytes": 3}, TEST_ORGANIZATION_ID)["uploadId"]
        api.store_restore_chunk(upload_id, 0, b"abc", TEST_ORGANIZATION_ID)
        with patch.object(api, "run_sql", side_effect=["f", ""]), patch.object(api, "ensure_organization_query_role", return_value=api.organization_query_role(TEST_ORGANIZATION_ID)), patch.object(api, "prepare_organization_database"), patch.object(api, "transfer_database_objects"), patch.object(api, "clear_database_quota_setting"), patch.object(api, "request_quota_reconcile"), patch.object(api, "run_pg_restore_from_upload", return_value=0):
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


if __name__ == "__main__":
    unittest.main()
