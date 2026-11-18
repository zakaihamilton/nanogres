import "server-only";

import { createPublicKey, verify as verifySignature } from "node:crypto";

type JsonMap = Record<string, unknown>;

export type WorkloadIdentityGrant = {
  id: string;
  issuer: string;
  audience: string;
  subject: string;
  database: string;
  role: string;
};

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

async function readJson(response: Response): Promise<JsonMap> {
  if (!response.ok) throw new Error("OIDC provider metadata could not be loaded.");
  const parsed = asObject(await response.json().catch(() => null));
  if (!parsed) throw new Error("OIDC provider metadata is invalid.");
  return parsed;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function verifyWorkloadIdentityToken(
  token: string,
  grant: WorkloadIdentityGrant,
): Promise<boolean> {
  if (token.length > 8192) return false;
  const issuer = httpsUrl(grant.issuer);
  if (!issuer || !grant.audience || !grant.subject) return false;
  const issuerBase = issuer.replace(/\/+$/, "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return false;

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJsonSegment(encodedHeader);
    const payload = decodeJsonSegment(encodedPayload);
    if (
      header.alg !== "RS256" ||
      (header.typ !== undefined && header.typ !== "JWT" && header.typ !== "jwt") ||
      typeof header.kid !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid) ||
      "jku" in header ||
      "x5u" in header ||
      "crit" in header
    ) {
      return false;
    }

    const metadataResponse = await fetch(
      `${issuerBase}/.well-known/openid-configuration`,
      {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      },
    );
    const metadata = await readJson(metadataResponse);
    const jwksUri = httpsUrl(metadata.jwks_uri);
    if (metadata.issuer !== issuer || !jwksUri) return false;

    const jwksResponse = await fetch(jwksUri, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    const jwks = await readJson(jwksResponse);
    if (!Array.isArray(jwks.keys)) return false;
    const key = jwks.keys
      .map(asObject)
      .find(
        (candidate) =>
          candidate !== null &&
          candidate.kid === header.kid &&
          candidate.kty === "RSA" &&
          (candidate.alg === undefined || candidate.alg === "RS256") &&
          (candidate.use === undefined || candidate.use === "sig") &&
          typeof candidate.n === "string" &&
          typeof candidate.e === "string",
      );
    if (!key) return false;

    const publicKey = createPublicKey({ key: key as never, format: "jwk" });
    const validSignature = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!validSignature) return false;

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
  } catch {
    return false;
  }
}
