import "server-only";

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { asObject, getSafeOidcErrorCode, httpsUrl, type JsonMap, requestJson } from "./ssrf-https";

type JwksCacheEntry = { expiresAt: number; keys: JsonMap[] };

type WorkloadIdentityFailureReason =
  | "token_too_large"
  | "invalid_grant"
  | "malformed_token"
  | "unsupported_header"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "authorized_party_mismatch"
  | "subject_mismatch"
  | "invalid_expiration"
  | "expired_token"
  | "invalid_not_before"
  | "not_yet_valid"
  | "invalid_issued_at"
  | "issued_at_in_future"
  | "invalid_lifetime"
  | "oidc_metadata_unavailable"
  | "oidc_metadata_invalid"
  | "jwks_unavailable"
  | "jwks_invalid"
  | "signing_key_not_found"
  | "invalid_signature"
  | "signature_verification_error";

export type WorkloadIdentityFailure = {
  reason: WorkloadIdentityFailureReason;
  code?: string;
};

class OidcLoadError extends Error {
  readonly reason: WorkloadIdentityFailureReason;
  readonly code?: string;

  constructor(reason: WorkloadIdentityFailureReason, code?: string) {
    super("OIDC provider metadata could not be loaded.");
    this.reason = reason;
    this.code = code;
    this.name = "OidcLoadError";
  }
}

export type WorkloadIdentityGrant = {
  id: string;
  issuer: string;
  audience: string;
  subject: string;
  database: string;
  role: string;
};

const OIDC_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_OIDC_CACHE_ENTRIES = 128;
const MAX_OIDC_FETCHES_IN_FLIGHT = 16;

const jwksCache = new Map<string, JwksCacheEntry>();
const jwksRequests = new Map<string, Promise<JsonMap[]>>();

function decodeJsonSegment(segment: string): JsonMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid workload token.");
  }
  const object = asObject(parsed);
  if (!object) throw new Error("Invalid workload token.");
  return object;
}

function cacheJwks(
  issuer: string,
  keys: JsonMap[],
  ttlMs: number = OIDC_CACHE_TTL_MS,
): void {
  jwksCache.delete(issuer);
  jwksCache.set(issuer, { expiresAt: Date.now() + ttlMs, keys });
  while (jwksCache.size > MAX_OIDC_CACHE_ENTRIES) {
    const oldestIssuer = jwksCache.keys().next().value;
    if (oldestIssuer === undefined) break;
    jwksCache.delete(oldestIssuer);
  }
}

async function loadJwks(issuer: string): Promise<JsonMap[]> {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    jwksCache.delete(issuer);
    jwksCache.set(issuer, cached);
    return cached.keys;
  }
  if (cached) jwksCache.delete(issuer);

  const pending = jwksRequests.get(issuer);
  if (pending) return pending;
  if (jwksRequests.size >= MAX_OIDC_FETCHES_IN_FLIGHT) {
    throw new Error("Too many OIDC metadata requests are in flight.");
  }

  const request = (async () => {
    try {
      const issuerUrl = new URL(issuer);
      const issuerBase = issuer.replace(/\/+$/, "");
      let metadata: JsonMap;
      try {
        metadata = await requestJson(new URL(`${issuerBase}/.well-known/openid-configuration`));
      } catch (error) {
        throw new OidcLoadError(
          "oidc_metadata_unavailable",
          getSafeOidcErrorCode(error) ?? "REQUEST_FAILED",
        );
      }
      const jwksUri = httpsUrl(metadata.jwks_uri);
      if (!jwksUri || metadata.issuer !== issuer || new URL(jwksUri).origin !== issuerUrl.origin) {
        throw new OidcLoadError("oidc_metadata_invalid");
      }
      let jwks: JsonMap;
      try {
        jwks = await requestJson(new URL(jwksUri));
      } catch (error) {
        throw new OidcLoadError(
          "jwks_unavailable",
          getSafeOidcErrorCode(error) ?? "REQUEST_FAILED",
        );
      }
      if (!Array.isArray(jwks.keys)) throw new OidcLoadError("jwks_invalid");
      const keys = jwks.keys.map(asObject).filter((key): key is JsonMap => key !== null);
      cacheJwks(issuer, keys);
      return keys;
    } catch (error) {
      cacheJwks(issuer, [], 30_000);
      throw error;
    }
  })().finally(() => jwksRequests.delete(issuer));
  jwksRequests.set(issuer, request);
  return request;
}

function getClaimFailures(
  payload: JsonMap,
  issuer: string,
  grant: WorkloadIdentityGrant,
): WorkloadIdentityFailureReason[] {
  const now = Math.floor(Date.now() / 1000);
  const audiences =
    typeof payload.aud === "string"
      ? [payload.aud]
      : Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === "string")
        ? (payload.aud as string[])
        : [];
  const failures: WorkloadIdentityFailureReason[] = [];

  if (payload.iss !== issuer) failures.push("issuer_mismatch");
  if (!audiences.includes(grant.audience)) failures.push("audience_mismatch");
  if (audiences.length > 1 && payload.azp !== grant.audience) {
    failures.push("authorized_party_mismatch");
  }
  if (payload.sub !== grant.subject) failures.push("subject_mismatch");

  if (typeof payload.exp !== "number") failures.push("invalid_expiration");
  else if (payload.exp <= now) failures.push("expired_token");

  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number") failures.push("invalid_not_before");
    else if (payload.nbf > now + 60) failures.push("not_yet_valid");
  }

  if (typeof payload.iat !== "number") failures.push("invalid_issued_at");
  else if (payload.iat > now + 60) failures.push("issued_at_in_future");

  if (
    typeof payload.exp === "number" &&
    typeof payload.iat === "number" &&
    payload.exp <= payload.iat
  ) {
    failures.push("invalid_lifetime");
  }

  return failures;
}

/** Verify an RS256 OIDC workload identity JWT against a Nanogres grant. */
export async function verifyWorkloadIdentityToken(
  token: string,
  grant: WorkloadIdentityGrant,
  onFailure?: (failure: WorkloadIdentityFailure) => void,
): Promise<boolean> {
  const fail = (reason: WorkloadIdentityFailureReason, code?: string) => {
    onFailure?.({ reason, ...(code ? { code } : {}) });
    return false;
  };

  if (token.length > 8192) return fail("token_too_large");
  const issuer = httpsUrl(grant.issuer);
  if (!issuer || !grant.audience || !grant.subject) return fail("invalid_grant");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return fail("malformed_token");

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: JsonMap;
  let payload: JsonMap;
  try {
    header = decodeJsonSegment(encodedHeader);
    payload = decodeJsonSegment(encodedPayload);
  } catch {
    return fail("malformed_token");
  }

  if (
    header.alg !== "RS256" ||
    (header.typ !== undefined && header.typ !== "JWT") ||
    typeof header.kid !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid) ||
    "jku" in header ||
    "x5u" in header ||
    "crit" in header
  ) {
    return fail("unsupported_header");
  }

  const claimFailures = getClaimFailures(payload, issuer, grant);
  if (claimFailures.length) {
    claimFailures.forEach((reason) => onFailure?.({ reason }));
    return false;
  }

  let keys: JsonMap[];
  try {
    keys = await loadJwks(issuer);
  } catch (error) {
    if (error instanceof OidcLoadError) return fail(error.reason, error.code);
    return fail("jwks_unavailable");
  }

  const key = keys.find(
    (candidate) =>
      candidate.kid === header.kid &&
      candidate.kty === "RSA" &&
      (candidate.alg === undefined || candidate.alg === "RS256") &&
      (candidate.use === undefined || candidate.use === "sig") &&
      typeof candidate.n === "string" &&
      typeof candidate.e === "string",
  );
  if (!key) return fail("signing_key_not_found");

  try {
    const publicKey = createPublicKey({ key: key as never, format: "jwk" });
    const isValid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
    );
    return isValid ? true : fail("invalid_signature");
  } catch {
    return fail("signature_verification_error");
  }
}
