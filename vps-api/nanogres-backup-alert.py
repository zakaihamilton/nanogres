#!/usr/bin/env python3
"""Notify an operator when verified off-site backup coverage changes state."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


STATE_DIR = Path(os.environ.get("NANOGRES_STATE_DIR", "/var/lib/nanogres"))
STATUS_FILE = STATE_DIR / "offsite-backup-status.json"
ALERT_STATE_FILE = STATE_DIR / "offsite-backup-alert-state.json"
LOCAL_BACKUP_ALERT_STATE_FILE = STATE_DIR / "local-backup-alert-state.json"
MAX_AGE_SECONDS = 36 * 60 * 60
HTTP_TIMEOUT_SECONDS = 10


def read_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def backup_state(status: dict[str, object], now: datetime) -> tuple[str, int | None]:
    if status.get("configured") is not True:
        return "unconfigured", None

    last_attempt = parse_timestamp(status.get("lastAttemptAt"))
    last_success = parse_timestamp(status.get("lastSuccessAt"))
    has_error = isinstance(status.get("lastError"), str) and bool(status["lastError"])
    if has_error and (last_success is None or last_attempt is None or last_attempt >= last_success):
        return "error", None
    if last_success is None:
        return ("stale", None) if last_attempt else ("pending", None)

    age_seconds = max(0, int((now - last_success).total_seconds()))
    if age_seconds >= MAX_AGE_SECONDS:
        return "stale", age_seconds
    return "fresh", age_seconds


def message_for(state: str, age_seconds: int | None) -> tuple[str, str]:
    if state == "error":
        return "backup_error", "The latest off-site backup attempt failed. Check the off-site service log."
    if state == "stale":
        if age_seconds is None:
            return "backup_stale", "No verified off-site backup is available yet."
        age_hours = age_seconds // 3600
        return "backup_stale", f"The latest verified off-site backup is {age_hours} hours old."
    return "backup_recovered", "Off-site backup verification is fresh again."


def local_backup_message(failed: bool) -> tuple[str, str, str]:
    if failed:
        return (
            "local_backup_failed",
            "error",
            "The scheduled local PostgreSQL backup failed. Check the backup service log.",
        )
    return (
        "local_backup_recovered",
        "recovered",
        "The scheduled local PostgreSQL backup completed successfully again.",
    )


def webhook_payload(event: str, state: str, message: str) -> dict[str, object]:
    format_name = os.environ.get("NANOGRES_ALERT_WEBHOOK_FORMAT", "generic").lower()
    if format_name == "slack":
        return {"text": f"Nanogres: {message}"}
    if format_name == "discord":
        return {"content": f"Nanogres: {message}"}
    if format_name != "generic":
        raise ValueError("NANOGRES_ALERT_WEBHOOK_FORMAT must be generic, slack, or discord.")
    return {
        "service": "nanogres",
        "event": event,
        "status": state,
        "message": message,
        "text": f"Nanogres: {message}",
    }


def send_webhook(url: str, payload: dict[str, object]) -> None:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    loopback_http = parsed.scheme == "http" and host in {"localhost", "127.0.0.1", "::1"}
    if (
        parsed.scheme != "https" and not loopback_http
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ValueError("The alert webhook must use HTTPS and must not include URL credentials or a fragment.")

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = os.environ.get("NANOGRES_ALERT_WEBHOOK_BEARER_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        status_code = response.getcode()
    if status_code < 200 or status_code >= 300:
        raise RuntimeError(f"Alert webhook returned HTTP {status_code}.")


def write_alert_state(value: dict[str, object]) -> None:
    write_json_file(ALERT_STATE_FILE, value)


def write_json_file(path: Path, value: dict[str, object]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=STATE_DIR)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def notify_if_needed(now: datetime | None = None) -> bool:
    webhook_url = os.environ.get("NANOGRES_ALERT_WEBHOOK_URL")
    if not webhook_url:
        return False

    status = read_json(STATUS_FILE)
    current_state, age_seconds = backup_state(status, now or datetime.now(timezone.utc))
    if current_state in {"unconfigured", "pending"}:
        return False

    previous_state = read_json(ALERT_STATE_FILE).get("alertedState")
    if current_state == "fresh":
        if previous_state not in {"error", "stale"}:
            return False
        event, message = message_for("recovered", age_seconds)
        payload = webhook_payload(event, "recovered", message)
        send_webhook(webhook_url, payload)
        write_alert_state({"alertedState": None, "lastNotifiedAt": datetime.now(timezone.utc).isoformat()})
        return True

    if previous_state == current_state:
        return False
    event, message = message_for(current_state, age_seconds)
    payload = webhook_payload(event, current_state, message)
    send_webhook(webhook_url, payload)
    write_alert_state(
        {"alertedState": current_state, "lastNotifiedAt": datetime.now(timezone.utc).isoformat()}
    )
    return True


def notify_local_backup_event(failed: bool) -> bool:
    webhook_url = os.environ.get("NANOGRES_ALERT_WEBHOOK_URL")
    if not webhook_url:
        return False

    previously_failed = read_json(LOCAL_BACKUP_ALERT_STATE_FILE).get("failed") is True
    if failed == previously_failed:
        return False

    event, state, message = local_backup_message(failed)
    payload = webhook_payload(event, state, message)
    send_webhook(webhook_url, payload)
    write_json_file(LOCAL_BACKUP_ALERT_STATE_FILE, {"failed": failed})
    return True


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--local-backup-failed"]:
            notify_local_backup_event(failed=True)
        elif sys.argv[1:] == ["--local-backup-succeeded"]:
            notify_local_backup_event(failed=False)
        elif not sys.argv[1:]:
            notify_if_needed()
        else:
            raise ValueError("Unsupported alert command.")
    except Exception as error:
        # Keep webhook destinations, credentials, and response bodies out of the journal.
        print(f"Nanogres backup alert failed ({type(error).__name__}).", file=sys.stderr)
        raise SystemExit(1)
