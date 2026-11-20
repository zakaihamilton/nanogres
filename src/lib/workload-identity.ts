import "server-only";

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lookup as dnsLookup, Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";

type JsonMap = Record<string, unknown>;
type IpFamily = 4 | 6;
type ResolvedAddress = { address: string; family: IpFamily };
type JwksCacheEntry = { expiresAt: number; keys: JsonMap[] };

export type WorkloadIdentityFailureReason =
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
  constructor(
    readonly reason: WorkloadIdentityFailureReason,
    readonly code?: string,
  ) {
    super("OIDC provider metadata could not be loaded.");
    this.name = "OidcLoadError";
  }
}

class OidcRequestError extends Error {
  constructor(readonly code: string) {
    super("OIDC provider request failed.");
    this.name = "OidcRequestError";
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

const MAX_OIDC_RESPONSE_BYTES = 1024 * 1024;
const OIDC_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_OIDC_CACHE_ENTRIES = 128;
const MAX_OIDC_FETCHES_IN_FLIGHT = 16;
const OIDC_REQUEST_TIMEOUT_MS = 8_000;
const OIDC_DOH_REQUEST_TIMEOUT_MS = 2_000;
const CLOUDFLARE_DOH_IPS = ["1.1.1.1", "1.0.0.1"] as const;
const oidcDnsResolver = new Resolver({ timeout: 1_500, tries: 1 });

const nonPublicAddresses = new BlockList();
for (const [network, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["3fff::", 20, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, family);
}

const jwksCache = new Map<string, JwksCacheEntry>();
const jwksRequests = new Map<string, Promise<JsonMap[]>>();

function asObject(value: unknown): JsonMap | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonMap)
    : null;
}

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

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      !url.hostname ||
      isIP(url.hostname) !== 0
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isPublicAddress(address: string, family: number): family is IpFamily {
  if (family !== 4 && family !== 6) return false;
  return !nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function resolvePublicAddress(url: URL): Promise<ResolvedAddress> {
  if (url.protocol !== "https:" || url.port || isIP(url.hostname) !== 0) {
    throw new OidcRequestError("URL_POLICY_REJECTED");
  }
  // dns.lookup() uses the operating system's name-resolution path, which may
  // include hosts files or platform-specific mappings. Query DNS directly as
  // well so a runtime mapping cannot hide the public records for a trusted
  // issuer. Every returned address still passes the public-IP check below and
  // the selected address is pinned for the TLS request.
  const results = await Promise.allSettled([
    dnsLookup(url.hostname, { all: true, verbatim: true }).then((addresses) =>
      addresses.map(({ address, family }) => ({ address, family: family as IpFamily })),
    ),
    oidcDnsResolver.resolve4(url.hostname).then((addresses) =>
      addresses.map((address) => ({ address, family: 4 as const })),
    ),
    oidcDnsResolver.resolve6(url.hostname).then((addresses) =>
      addresses.map((address) => ({ address, family: 6 as const })),
    ),
  ]);
  const addresses: ResolvedAddress[] = [];
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") addresses.push(...result.value);
    else errors.push(result.reason);
  }
  if (!addresses.length) {
    const resolutionError = errors.find((error) => {
      const code = getSafeOidcErrorCode(error);
      return code !== "ENODATA" && code !== "ENOTFOUND";
    });
    if (resolutionError) throw resolutionError;
    throw new OidcRequestError("DNS_NO_ADDRESSES");
  }

  const publicAddresses = addresses.filter(({ address, family }) =>
    isPublicAddress(address, family),
  );
  let selected: ResolvedAddress | undefined = publicAddresses[0];
  if (!selected && url.hostname === "oidc.vercel.com") {
    const dohResults = await Promise.allSettled([
      queryCloudflareDns(url.hostname, "A"),
      queryCloudflareDns(url.hostname, "AAAA"),
    ]);
    const dohAddresses = dohResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    selected = dohAddresses.find(({ address, family }) =>
      isPublicAddress(address, family),
    );
    if (!selected) {
      const dohError = dohResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )?.reason;
      if (dohError) {
        throw new OidcRequestError(getSafeOidcErrorCode(dohError) ?? "DOH_REQUEST_FAILED");
      }
    }
  }
  if (!selected) throw new OidcRequestError("DNS_NO_PUBLIC_ADDRESS");
  if (selected.family !== 4 && selected.family !== 6) {
    throw new OidcRequestError("DNS_UNSUPPORTED_ADDRESS_FAMILY");
  }
  return { address: selected.address, family: selected.family };
}

function pinnedLookup(url: URL, address: ResolvedAddress): NonNullable<RequestOptions["lookup"]> {
  return ((hostname, options, callback) => {
    if (hostname !== url.hostname) {
      const error = Object.assign(new Error("OIDC host changed during lookup."), {
        code: "EACCES",
      }) as NodeJS.ErrnoException;
      callback(error, "", address.family);
      return;
    }
    if (options.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  }) as NonNullable<RequestOptions["lookup"]>;
}

async function requestJson(url: URL): Promise<JsonMap> {
  let address: ResolvedAddress;
  try {
    address = await resolvePublicAddress(url);
  } catch (error) {
    throw new OidcRequestError(getSafeOidcErrorCode(error) ?? "DNS_OR_ADDRESS_REJECTED");
  }
  return requestJsonAtAddress(url, address);
}

async function requestJsonAtAddress(
  url: URL,
  address: ResolvedAddress,
  accept: string = "application/json",
  timeoutMs: number = OIDC_REQUEST_TIMEOUT_MS,
): Promise<JsonMap> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: { Accept: accept },
        lookup: pinnedLookup(url, address),
        servername: url.hostname,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new OidcRequestError(`HTTP_${response.statusCode ?? "UNKNOWN"}`));
          return;
        }
        const contentLength = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_OIDC_RESPONSE_BYTES) {
          const error = new OidcRequestError("RESPONSE_TOO_LARGE");
          response.destroy(error);
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_OIDC_RESPONSE_BYTES) {
            response.destroy(new OidcRequestError("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
          } catch {
            reject(new OidcRequestError("INVALID_JSON"));
            return;
          }
          const object = asObject(parsed);
          if (!object) {
            reject(new OidcRequestError("INVALID_JSON_OBJECT"));
            return;
          }
          resolve(object);
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function queryCloudflareDns(
  hostname: string,
  recordType: "A" | "AAAA",
): Promise<ResolvedAddress[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", recordType);

  let response: JsonMap | undefined;
  let lastError: unknown;
  for (const address of CLOUDFLARE_DOH_IPS) {
    try {
      response = await requestJsonAtAddress(
        url,
        { address, family: 4 },
        "application/dns-json",
        OIDC_DOH_REQUEST_TIMEOUT_MS,
      );
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!response) {
    throw new OidcRequestError(getSafeOidcErrorCode(lastError) ?? "DOH_REQUEST_FAILED");
  }
  if (response.Status !== 0) {
    const status = typeof response.Status === "number" ? response.Status : "UNKNOWN";
    throw new OidcRequestError(`DOH_DNS_STATUS_${status}`);
  }

  const expectedRecordType = recordType === "A" ? 1 : 28;
  const expectedFamily = recordType === "A" ? 4 : 6;
  const answers = Array.isArray(response.Answer) ? response.Answer : [];
  return answers
    .map(asObject)
    .filter((answer): answer is JsonMap => answer !== null)
    .filter((answer) => answer.type === expectedRecordType)
    .map((answer) => answer.data)
    .filter(
      (address): address is string =>
        typeof address === "string" && isIP(address) === expectedFamily,
    )
    .map((address) => ({ address, family: expectedFamily }));
}

function getSafeOidcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  if (typeof candidate.code === "string" && /^[A-Z0-9_]{1,40}$/.test(candidate.code)) {
    return candidate.code;
  }
  if (
    typeof candidate.statusCode === "number" &&
    candidate.statusCode >= 100 &&
    candidate.statusCode <= 599
  ) {
    return `HTTP_${candidate.statusCode}`;
  }
  return undefined;
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
      const keys = jwks.keys
        .map(asObject)
        .filter((key): key is JsonMap => key !== null);
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
      Buffer.from(encodedHeader + "." + encodedPayload, "utf8"),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
    );
    return isValid ? true : fail("invalid_signature");
  } catch {
    return fail("signature_verification_error");
  }
}
