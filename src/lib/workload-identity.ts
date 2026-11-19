import "server-only";

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";

type JsonMap = Record<string, unknown>;
type IpFamily = 4 | 6;
type ResolvedAddress = { address: string; family: IpFamily };
type JwksCacheEntry = { expiresAt: number; keys: JsonMap[] };

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
    throw new Error("OIDC URLs must use a public HTTPS hostname on port 443.");
  }
  const addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    throw new Error("OIDC host must resolve exclusively to public IP addresses.");
  }
  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error("OIDC host did not resolve to a supported IP address.");
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
  const address = await resolvePublicAddress(url);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        lookup: pinnedLookup(url, address),
        servername: url.hostname,
        signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("OIDC provider metadata could not be loaded."));
          return;
        }
        const contentLength = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_OIDC_RESPONSE_BYTES) {
          response.destroy(new Error("OIDC provider response is too large."));
          reject(new Error("OIDC provider response is too large."));
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_OIDC_RESPONSE_BYTES) {
            response.destroy(new Error("OIDC provider response is too large."));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
          } catch {
            reject(new Error("OIDC provider metadata is invalid."));
            return;
          }
          const object = asObject(parsed);
          if (!object) {
            reject(new Error("OIDC provider metadata is invalid."));
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
      const metadata = await requestJson(
        new URL(`${issuerBase}/.well-known/openid-configuration`),
      );
      const jwksUri = httpsUrl(metadata.jwks_uri);
      if (!jwksUri || metadata.issuer !== issuer || new URL(jwksUri).origin !== issuerUrl.origin) {
        throw new Error("OIDC provider metadata has an invalid issuer or JWKS URL.");
      }
      const jwks = await requestJson(new URL(jwksUri));
      if (!Array.isArray(jwks.keys)) throw new Error("OIDC provider keys are invalid.");
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

function hasValidClaims(payload: JsonMap, issuer: string, grant: WorkloadIdentityGrant): boolean {
  const now = Math.floor(Date.now() / 1000);
  const audiences =
    typeof payload.aud === "string"
      ? [payload.aud]
      : Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === "string")
        ? (payload.aud as string[])
        : [];
  return (
    payload.iss === issuer &&
    audiences.includes(grant.audience) &&
    (audiences.length <= 1 || payload.azp === grant.audience) &&
    payload.sub === grant.subject &&
    typeof payload.exp === "number" &&
    payload.exp > now &&
    (payload.nbf === undefined || (typeof payload.nbf === "number" && payload.nbf <= now + 60)) &&
    typeof payload.iat === "number" &&
    payload.iat <= now + 60 &&
    payload.exp > payload.iat
  );
}

export async function verifyWorkloadIdentityToken(
  token: string,
  grant: WorkloadIdentityGrant,
): Promise<boolean> {
  if (token.length > 8192) return false;
  const issuer = httpsUrl(grant.issuer);
  if (!issuer || !grant.audience || !grant.subject) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return false;

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJsonSegment(encodedHeader);
    const payload = decodeJsonSegment(encodedPayload);
    if (
      header.alg !== "RS256" ||
      (header.typ !== undefined && header.typ !== "JWT") ||
      typeof header.kid !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid) ||
      "jku" in header ||
      "x5u" in header ||
      "crit" in header
    ) {
      return false;
    }
    if (!hasValidClaims(payload, issuer, grant)) return false;

    const keys = await loadJwks(issuer);
    const key = keys.find(
      (candidate) =>
        candidate.kid === header.kid &&
        candidate.kty === "RSA" &&
        (candidate.alg === undefined || candidate.alg === "RS256") &&
        (candidate.use === undefined || candidate.use === "sig") &&
        typeof candidate.n === "string" &&
        typeof candidate.e === "string",
    );
    if (!key) return false;

    const publicKey = createPublicKey({ key: key as never, format: "jwk" });
    return verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    return false;
  }
}
