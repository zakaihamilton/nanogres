"""Workload identity grants, ephemeral SSH forwarding keys, and client certificates."""

from __future__ import annotations

import base64
import binascii
import hashlib
import ipaddress
import json
import secrets
import subprocess
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from . import config as _config
from . import tenants as _tenants
from .config import (
    ApiError,
    NAME_PATTERN,
    WORKLOAD_IDENTITY_PATTERN,
    workload_identity_lock,
    workload_ssh_key_lock,
)


def _workload_identity_path(organization_id: object) -> Path:
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    return _config.cfg("WORKLOAD_IDENTITY_DIR") / f"{prefix.rstrip('_')}.json"


def _read_workload_identities(organization_id: object) -> list[dict[str, object]]:
    path = _config.resolve("_workload_identity_path", _workload_identity_path)(organization_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(503, "Nanogres could not read workload identity grants.") from error
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ApiError(503, "Nanogres workload identity grants are invalid.")
    return value


def _write_workload_identities(
    organization_id: object,
    identities: list[dict[str, object]],
) -> None:
    _config.cfg("WORKLOAD_IDENTITY_DIR").mkdir(mode=0o700, parents=True, exist_ok=True)
    path = _config.resolve("_workload_identity_path", _workload_identity_path)(organization_id)
    _config.atomic_write_text(
        path,
        json.dumps(identities, separators=(",", ":")),
        prefix=f".{path.name}.",
    )


def list_workload_identities(organization_id: object) -> list[dict[str, object]]:
    """Return configured workload identity grants for an organization."""
    with workload_identity_lock:
        return _config.resolve("_read_workload_identities", _read_workload_identities)(
            organization_id
        )


def create_workload_identity(
    body: dict[str, object],
    actor: str | None,
    organization_id: object,
) -> dict[str, object]:
    """Validate and store a new OIDC workload identity grant."""
    label = str(body.get("name", "")).strip()
    issuer = str(body.get("issuer", "")).strip()
    audience = str(body.get("audience", "")).strip()
    subject = str(body.get("subject", "")).strip()
    logical_database = str(body.get("database", ""))
    logical_role = str(body.get("role", ""))
    try:
        issuer_url = urlsplit(issuer)
        issuer_host = issuer_url.hostname
        issuer_port = issuer_url.port
    except ValueError as error:
        raise ApiError(400, "Issuer must be a valid HTTPS URL.") from error
    try:
        ipaddress.ip_address(issuer_host or "")
        issuer_is_ip = True
    except ValueError:
        issuer_is_ip = False
    local_host = bool(
        issuer_host
        and (
            issuer_host == "localhost"
            or issuer_host.endswith((".localhost", ".local", ".internal", ".test", ".invalid"))
        )
    )
    if (
        not 1 <= len(label) <= 128
        or any(ord(character) < 32 or ord(character) == 127 for character in label)
        or issuer_url.scheme != "https"
        or not issuer_url.netloc
        or issuer_url.username is not None
        or issuer_url.password is not None
        or issuer_port not in (None, 443)
        or not issuer_host
        or "." not in issuer_host
        or issuer_host.endswith(".")
        or issuer_is_ip
        or local_host
        or issuer_url.query
        or issuer_url.fragment
        or not 1 <= len(issuer) <= 512
        or not 1 <= len(audience) <= 512
        or any(ord(character) < 32 or ord(character) == 127 for character in audience)
        or not 1 <= len(subject) <= 512
        or any(ord(character) < 32 or ord(character) == 127 for character in subject)
    ):
        raise ApiError(400, "Provide a public HTTPS issuer hostname, audience, and subject.")
    database = _config.resolve(
        "require_organization_database", _tenants.require_organization_database
    )(organization_id, logical_database)
    roles = _config.resolve("list_roles", _tenants.list_roles)(organization_id)
    role = next(
        (
            item
            for item in roles
            if item.get("name") == logical_role and item.get("connectionDatabase") == database
        ),
        None,
    )
    if role is None:
        raise ApiError(400, "Choose a login role scoped to this database.")

    with workload_identity_lock:
        identities = _config.resolve("_read_workload_identities", _read_workload_identities)(
            organization_id
        )
        if any(
            item.get("issuer") == issuer
            and item.get("audience") == audience
            and item.get("subject") == subject
            and item.get("database") == logical_database
            and item.get("role") == logical_role
            for item in identities
        ):
            raise ApiError(409, "That workload identity grant already exists.")
        identity: dict[str, object] = {
            "id": uuid.uuid4().hex,
            "name": label,
            "issuer": issuer,
            "audience": audience,
            "subject": subject,
            "database": logical_database,
            "role": logical_role,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "createdBy": actor,
        }
        identities.append(identity)
        _config.resolve("_write_workload_identities", _write_workload_identities)(
            organization_id, identities
        )
    return identity


def delete_workload_identity(identity_id: str, organization_id: object) -> None:
    """Delete a workload identity grant and revoke any associated ephemeral SSH keys."""
    if not WORKLOAD_IDENTITY_PATTERN.fullmatch(identity_id):
        raise ApiError(404, "Workload identity grant not found.")
    with workload_identity_lock:
        identities = _config.resolve("_read_workload_identities", _read_workload_identities)(
            organization_id
        )
        updated = [item for item in identities if item.get("id") != identity_id]
        if len(updated) == len(identities):
            raise ApiError(404, "Workload identity grant not found.")
        with workload_ssh_key_lock:
            keys = _config.resolve("_read_workload_ssh_keys", _read_workload_ssh_keys)()
            _config.resolve("_write_workload_ssh_keys", _write_workload_ssh_keys)(
                [item for item in keys if item.get("grantId") != identity_id]
            )
            _config.resolve("_write_workload_identities", _write_workload_identities)(
                organization_id, updated
            )


def _workload_ssh_key_path() -> Path:
    return _config.cfg("WORKLOAD_IDENTITY_DIR") / "ssh-keys.json"


def _read_workload_ssh_keys() -> list[dict[str, object]]:
    try:
        value = json.loads(
            _config.resolve("_workload_ssh_key_path", _workload_ssh_key_path)().read_text(
                encoding="utf-8"
            )
        )
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as error:
        raise ApiError(503, "Nanogres could not read workload SSH keys.") from error
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ApiError(503, "Nanogres workload SSH key state is invalid.")
    return value


def _write_workload_ssh_keys(keys: list[dict[str, object]]) -> None:
    _config.cfg("WORKLOAD_IDENTITY_DIR").mkdir(mode=0o700, parents=True, exist_ok=True)
    path = _config.resolve("_workload_ssh_key_path", _workload_ssh_key_path)()
    _config.atomic_write_text(
        path,
        json.dumps(keys, separators=(",", ":")),
        prefix=".ssh-keys.",
    )


def _parse_workload_ssh_public_key(value: object) -> tuple[str, str]:
    if not isinstance(value, str) or len(value) > 1024:
        raise ApiError(400, "Provide a valid Ed25519 SSH public key.")
    parts = value.strip().split()
    if len(parts) not in {2, 3} or parts[0] != "ssh-ed25519":
        raise ApiError(400, "Only Ed25519 workload SSH keys are supported.")
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ApiError(400, "Provide a valid Ed25519 SSH public key.") from error
    if (
        len(blob) != 51
        or blob[:4] != b"\x00\x00\x00\x0b"
        or blob[4:15] != b"ssh-ed25519"
        or blob[15:19] != b"\x00\x00\x00\x20"
    ):
        raise ApiError(400, "Provide a valid Ed25519 SSH public key.")
    fingerprint = (
        "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    )
    return f"ssh-ed25519 {parts[1]}", fingerprint


def _register_workload_ssh_key(
    public_key: object,
    grant_id: str,
    organization_id: object,
    database: str,
    role: str,
    migration_role: bool,
    expires: datetime,
) -> None:
    normalized_key, fingerprint = _config.resolve(
        "_parse_workload_ssh_public_key", _parse_workload_ssh_public_key
    )(public_key)
    with workload_ssh_key_lock:
        now = datetime.now(timezone.utc)
        keys = [
            item
            for item in _config.resolve("_read_workload_ssh_keys", _read_workload_ssh_keys)()
            if isinstance(item.get("expiresAt"), str)
            and datetime.fromisoformat(str(item["expiresAt"])) > now
        ]
        if any(item.get("fingerprint") == fingerprint for item in keys):
            raise ApiError(409, "That workload SSH key is already active.")
        keys.append(
            {
                "fingerprint": fingerprint,
                "publicKey": normalized_key,
                "grantId": grant_id,
                "organizationId": str(organization_id),
                "database": database,
                "role": role,
                "port": 6435 if migration_role else 6434,
                "expiresAt": expires.isoformat(),
            }
        )
        _config.resolve("_write_workload_ssh_keys", _write_workload_ssh_keys)(keys)


def workload_authorized_ssh_key(username: str, fingerprint: str) -> str | None:
    """Return an `AuthorizedKeysCommand` entry for an active workload SSH key, if valid."""
    if username != "nanogres-workload" or len(fingerprint) > 64:
        return None
    try:
        with workload_ssh_key_lock:
            keys = _config.resolve("_read_workload_ssh_keys", _read_workload_ssh_keys)()
        now = datetime.now(timezone.utc)
        for item in keys:
            expires_at = item.get("expiresAt")
            if (
                item.get("fingerprint") != fingerprint
                or not isinstance(expires_at, str)
                or datetime.fromisoformat(expires_at) <= now
                or item.get("port") not in {6434, 6435}
                or not isinstance(item.get("publicKey"), str)
            ):
                continue
            port = int(item["port"])
            options = (
                "no-agent-forwarding,no-X11-forwarding,no-pty,"
                f'permitopen="127.0.0.1:{port}"'
            )
            return f"{options} {item['publicKey']} nanogres-workload"
    except (ApiError, OSError, ValueError):
        return None
    return None


def workload_ssh_host_key_sha256() -> str:
    """Return the hex SHA-256 digest of the host's Ed25519 SSH public key."""
    host_key = Path("/etc/ssh/ssh_host_ed25519_key.pub")
    try:
        parts = host_key.read_text(encoding="ascii").split()
        if len(parts) < 2 or parts[0] != "ssh-ed25519":
            raise ValueError("Expected an Ed25519 SSH host key.")
        blob = base64.b64decode(parts[1], validate=True)
    except (OSError, IndexError, ValueError, binascii.Error) as error:
        raise ApiError(503, "Nanogres SSH host identity is not configured.") from error
    return hashlib.sha256(blob).hexdigest()


def issue_workload_certificate(
    body: dict[str, object],
    organization_id: object,
) -> dict[str, object]:
    """Mint a short-lived mTLS PostgreSQL client certificate and register its SSH tunnel key."""
    grant_id = str(body.get("grantId", ""))
    logical_database = str(body.get("database", ""))
    logical_role = str(body.get("role", ""))
    ssh_public_key = body.get("sshPublicKey")
    if not WORKLOAD_IDENTITY_PATTERN.fullmatch(grant_id):
        raise ApiError(403, "No matching workload identity grant.")
    database = _config.resolve(
        "require_organization_database", _tenants.require_organization_database
    )(organization_id, logical_database)
    identities = _config.resolve("list_workload_identities", list_workload_identities)(
        organization_id
    )
    grant = next(
        (
            item
            for item in identities
            if item.get("id") == grant_id
            and item.get("database") == logical_database
            and item.get("role") == logical_role
        ),
        None,
    )
    if grant is None:
        raise ApiError(403, "No matching workload identity grant.")
    roles = _config.resolve("list_roles", _tenants.list_roles)(organization_id)
    role = next(
        (
            item
            for item in roles
            if item.get("name") == logical_role and item.get("connectionDatabase") == database
        ),
        None,
    )
    username = role.get("loginName") if role else None
    if not isinstance(username, str) or not NAME_PATTERN.fullmatch(username):
        raise ApiError(403, "The granted database role is no longer available.")

    ca_certificate = Path("/etc/nanogres/pgbouncer/client-ca.crt")
    ca_private_key = Path("/etc/nanogres/pgbouncer/client-ca.key")
    if not ca_certificate.is_file() or not ca_private_key.is_file():
        raise ApiError(503, "Nanogres workload identity certificates are not configured.")

    now = datetime.now(timezone.utc)
    start_date = (now - timedelta(seconds=60)).strftime("%Y%m%d%H%M%SZ")
    expires = now + timedelta(seconds=900)
    end_date = expires.strftime("%Y%m%d%H%M%SZ")
    with tempfile.TemporaryDirectory(prefix="nanogres-workload-") as temp_dir:
        directory = Path(temp_dir)
        (directory / "certs").mkdir(mode=0o700)
        (directory / "index.txt").write_text("", encoding="ascii")
        (directory / "serial").write_text(secrets.token_hex(16).upper() + "\n", encoding="ascii")
        config = directory / "openssl.cnf"
        config.write_text(
            "\n".join(
                [
                    "[ ca ]",
                    "default_ca = CA_default",
                    "[ CA_default ]",
                    f"database = {directory / 'index.txt'}",
                    f"new_certs_dir = {directory / 'certs'}",
                    f"certificate = {ca_certificate}",
                    f"private_key = {ca_private_key}",
                    f"serial = {directory / 'serial'}",
                    "default_md = sha256",
                    "default_days = 1",
                    "policy = policy_any",
                    "unique_subject = no",
                    "copy_extensions = none",
                    "[ policy_any ]",
                    "commonName = supplied",
                    "[ workload_client ]",
                    "basicConstraints = critical,CA:FALSE",
                    "keyUsage = critical,digitalSignature,keyEncipherment",
                    "extendedKeyUsage = clientAuth",
                    "subjectKeyIdentifier = hash",
                    "authorityKeyIdentifier = keyid,issuer",
                ]
            ),
            encoding="ascii",
        )
        client_key = directory / "client.key"
        csr = directory / "client.csr"
        certificate = directory / "client.crt"
        subprocess.run(
            [
                "openssl",
                "req",
                "-new",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-subj",
                f"/CN={username}",
                "-keyout",
                str(client_key),
                "-out",
                str(csr),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        subprocess.run(
            [
                "openssl",
                "ca",
                "-batch",
                "-config",
                str(config),
                "-in",
                str(csr),
                "-out",
                str(certificate),
                "-notext",
                "-extensions",
                "workload_client",
                "-startdate",
                start_date,
                "-enddate",
                end_date,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        migration_role = role.get("migrationRole") is True
        host_key_sha256 = _config.resolve(
            "workload_ssh_host_key_sha256", workload_ssh_host_key_sha256
        )()
        with workload_identity_lock:
            grant_is_active = any(
                item.get("id") == grant_id
                and item.get("database") == logical_database
                and item.get("role") == logical_role
                for item in _config.resolve("_read_workload_identities", _read_workload_identities)(
                    organization_id
                )
            )
            if not grant_is_active:
                raise ApiError(403, "No matching workload identity grant.")
            _config.resolve("_register_workload_ssh_key", _register_workload_ssh_key)(
                ssh_public_key,
                grant_id,
                organization_id,
                str(role.get("connectionDatabase")),
                logical_role,
                migration_role,
                expires,
            )
        return {
            "clientCert": certificate.read_text(encoding="ascii"),
            "clientKey": client_key.read_text(encoding="ascii"),
            "expiresAt": expires.isoformat(),
            "host": "127.0.0.1",
            "port": 6435 if migration_role else 6434,
            "user": username,
            "database": str(role.get("connectionDatabase")),
            "tlsServerName": "nanogres.duckdns.org",
            "pooling": "session" if migration_role else "transaction",
            "sshHost": "nanogres.duckdns.org",
            "sshPort": 8443,
            "sshPath": "/_nanogres/workload-ssh",
            "sshUsername": "nanogres-workload",
            "sshHostKeySha256": host_key_sha256,
        }
