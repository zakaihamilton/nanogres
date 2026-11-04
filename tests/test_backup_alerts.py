"""Test opt-in off-site backup alerts without contacting external services."""

import importlib.util
import http.server
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "nanogres_backup_alert", Path(__file__).resolve().parents[1] / "vps-api/nanogres-backup-alert.py"
)
alerts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alerts)


class FakeResponse:
    def __init__(self, status=204):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status


class BackupAlertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.status_file = root / "offsite-backup-status.json"
        self.alert_state_file = root / "offsite-backup-alert-state.json"
        self.local_alert_state_file = root / "local-backup-alert-state.json"
        self.patches = [
            patch.object(alerts, "STATE_DIR", root),
            patch.object(alerts, "STATUS_FILE", self.status_file),
            patch.object(alerts, "ALERT_STATE_FILE", self.alert_state_file),
            patch.object(alerts, "LOCAL_BACKUP_ALERT_STATE_FILE", self.local_alert_state_file),
        ]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.now = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
        self.webhook = patch.dict(
            os.environ,
            {
                "NANOGRES_ALERT_WEBHOOK_URL": "http://127.0.0.1/alerts",
                "NANOGRES_ALERT_WEBHOOK_BEARER_TOKEN": "test-only-token",
                "NANOGRES_ALERT_WEBHOOK_FORMAT": "generic",
            },
        )
        self.webhook.start()
        self.addCleanup(self.webhook.stop)

    def set_status(self, value):
        self.status_file.write_text(json.dumps(value), encoding="utf-8")

    def test_stale_transition_sends_one_redacted_authenticated_notification(self):
        last_success = (self.now - timedelta(hours=40)).isoformat()
        self.set_status(
            {"configured": True, "lastSuccessAt": last_success, "lastAttemptAt": last_success}
        )
        requests = []

        def capture(request, timeout):
            requests.append((request, timeout))
            return FakeResponse()

        with patch.object(alerts.urllib.request, "urlopen", side_effect=capture):
            self.assertTrue(alerts.notify_if_needed(self.now))
            self.assertFalse(alerts.notify_if_needed(self.now))

        self.assertEqual(len(requests), 1)
        request, timeout = requests[0]
        payload = json.loads(request.data)
        self.assertEqual(payload["event"], "backup_stale")
        self.assertEqual(payload["status"], "stale")
        self.assertIn("40 hours old", payload["message"])
        self.assertEqual(request.get_header("Authorization"), "Bearer test-only-token")
        self.assertEqual(timeout, alerts.HTTP_TIMEOUT_SECONDS)
        self.assertNotIn("test-only-token", self.alert_state_file.read_text(encoding="utf-8"))

    def test_latest_failed_copy_alerts_and_fresh_copy_sends_recovery(self):
        success = (self.now - timedelta(hours=1)).isoformat()
        attempt = self.now.isoformat()
        self.set_status(
            {
                "configured": True,
                "lastSuccessAt": success,
                "lastAttemptAt": attempt,
                "lastError": "safe status only",
            }
        )
        requests = []
        with patch.object(
            alerts.urllib.request,
            "urlopen",
            side_effect=lambda request, timeout: requests.append(json.loads(request.data)) or FakeResponse(),
        ):
            self.assertTrue(alerts.notify_if_needed(self.now))
            self.set_status(
                {
                    "configured": True,
                    "lastSuccessAt": self.now.isoformat(),
                    "lastAttemptAt": self.now.isoformat(),
                    "lastError": None,
                }
            )
            self.assertTrue(alerts.notify_if_needed(self.now))

        self.assertEqual([item["status"] for item in requests], ["error", "recovered"])
        self.assertEqual([item["event"] for item in requests], ["backup_error", "backup_recovered"])
        self.assertNotIn("safe status only", json.dumps(requests))

    def test_alerting_is_disabled_without_a_webhook_and_ignores_pending_status(self):
        self.set_status({"configured": True})
        with patch.dict(os.environ, {}, clear=True), patch.object(alerts.urllib.request, "urlopen") as send:
            self.assertFalse(alerts.notify_if_needed(self.now))
            os.environ["NANOGRES_ALERT_WEBHOOK_URL"] = "http://127.0.0.1/alerts"
            self.assertFalse(alerts.notify_if_needed(self.now))
            send.assert_not_called()

    def test_rejects_plain_http_and_unsupported_formats(self):
        with self.assertRaises(ValueError):
            alerts.send_webhook("http://example.com/alerts", {"text": "test"})
        with patch.dict(os.environ, {"NANOGRES_ALERT_WEBHOOK_FORMAT": "unknown"}):
            with self.assertRaises(ValueError):
                alerts.webhook_payload("backup_stale", "stale", "test")

    def test_local_backup_failure_alert_is_deduplicated_and_recovers(self):
        requests = []
        with patch.object(
            alerts.urllib.request,
            "urlopen",
            side_effect=lambda request, timeout: requests.append(json.loads(request.data)) or FakeResponse(),
        ):
            self.assertTrue(alerts.notify_local_backup_event(failed=True))
            self.assertFalse(alerts.notify_local_backup_event(failed=True))
            self.assertTrue(alerts.notify_local_backup_event(failed=False))

        self.assertEqual([item["status"] for item in requests], ["error", "recovered"])
        self.assertEqual(
            [item["event"] for item in requests],
            ["local_backup_failed", "local_backup_recovered"],
        )

    def test_posts_json_to_a_real_loopback_webhook_receiver(self):
        received = []

        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                received.append(
                    {
                        "authorization": self.headers.get("Authorization"),
                        "payload": json.loads(self.rfile.read(length)),
                    }
                )
                self.send_response(204)
                self.end_headers()

            def log_message(self, _format, *_args):
                return

        server = http.server.HTTPServer(("127.0.0.1", 0), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        alerts.send_webhook(
            f"http://127.0.0.1:{server.server_port}/alerts", {"text": "loopback test"}
        )

        self.assertEqual(received[0]["authorization"], "Bearer test-only-token")
        self.assertEqual(received[0]["payload"], {"text": "loopback test"})


if __name__ == "__main__":
    unittest.main()
