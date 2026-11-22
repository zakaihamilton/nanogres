import "server-only";

import { lookup as dnsLookup, Resolver } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

export type JsonMap = Record<string, unknown>;
type IpFamily = 4 | 6;
type ResolvedAddress = { address: string; family: IpFamily };
type DnsOverHttpsResolver = {
  hostname: string;
  path: string;
  addresses: readonly string[];
};

class SsrfRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("HTTPS provider request failed.");
    this.code = code;
    this.name = "SsrfRequestError";
  }
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const DOH_REQUEST_TIMEOUT_MS = 2_000;
const DOH_RESOLVERS = [
  {
    hostname: "cloudflare-dns.com",
    path: "/dns-query",
    addresses: ["1.1.1.1", "1.0.0.1"],
  },
  {
    hostname: "dns.google",
    path: "/resolve",
    addresses: ["8.8.8.8", "8.8.4.4"],
  },
] as const satisfies readonly DnsOverHttpsResolver[];
const oidcDnsResolver = new Resolver({ timeout: 1_500, tries: 1 });

const nonPublicIpv4Addresses = new BlockList();
const nonPublicIpv6Addresses = new BlockList();
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
  (family === "ipv4" ? nonPublicIpv4Addresses : nonPublicIpv6Addresses).addSubnet(
    network,
    prefix,
    family,
  );
}

export function asObject(value: unknown): JsonMap | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonMap)
    : null;
}

export function httpsUrl(value: unknown): string | null {
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

export function getSafeOidcErrorCode(error: unknown): string | undefined {
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

function isPublicAddress(address: string, family: number): family is IpFamily {
  if (family !== 4 && family !== 6) return false;
  const blockedAddresses = family === 4 ? nonPublicIpv4Addresses : nonPublicIpv6Addresses;
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
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

async function requestJsonAtAddress(
  url: URL,
  address: ResolvedAddress,
  accept: string = "application/json",
  timeoutMs: number = REQUEST_TIMEOUT_MS,
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
          reject(new SsrfRequestError(`HTTP_${response.statusCode ?? "UNKNOWN"}`));
          return;
        }
        const contentLength = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          const error = new SsrfRequestError("RESPONSE_TOO_LARGE");
          response.destroy(error);
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            response.destroy(new SsrfRequestError("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
          } catch {
            reject(new SsrfRequestError("INVALID_JSON"));
            return;
          }
          const object = asObject(parsed);
          if (!object) {
            reject(new SsrfRequestError("INVALID_JSON_OBJECT"));
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

async function queryDohDns(
  hostname: string,
  recordType: "A" | "AAAA",
  resolver: DnsOverHttpsResolver,
): Promise<ResolvedAddress[]> {
  if (hostname !== "oidc.vercel.com") {
    throw new SsrfRequestError("DOH_HOST_REJECTED");
  }
  const url = new URL(resolver.path, `https://${resolver.hostname}`);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", recordType);

  let response: JsonMap | undefined;
  let lastError: unknown;
  for (const address of resolver.addresses) {
    try {
      response = await requestJsonAtAddress(
        url,
        { address, family: 4 },
        "application/dns-json",
        DOH_REQUEST_TIMEOUT_MS,
      );
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!response) {
    throw new SsrfRequestError(getSafeOidcErrorCode(lastError) ?? "DOH_REQUEST_FAILED");
  }
  if (response.Status !== 0) {
    const status = typeof response.Status === "number" ? response.Status : "UNKNOWN";
    throw new SsrfRequestError(`DOH_DNS_STATUS_${status}`);
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

async function resolvePublicAddress(url: URL): Promise<ResolvedAddress> {
  if (url.protocol !== "https:" || url.port || isIP(url.hostname) !== 0) {
    throw new SsrfRequestError("URL_POLICY_REJECTED");
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
    throw new SsrfRequestError("DNS_NO_ADDRESSES");
  }

  const publicAddresses = addresses.filter(({ address, family }) =>
    isPublicAddress(address, family),
  );
  let selected: ResolvedAddress | undefined = publicAddresses[0];
  if (!selected && url.hostname === "oidc.vercel.com") {
    let dohError: unknown;
    let dohReturnedAddresses = false;
    for (const resolver of DOH_RESOLVERS) {
      const dohResults = await Promise.allSettled([
        queryDohDns(url.hostname, "A", resolver),
        queryDohDns(url.hostname, "AAAA", resolver),
      ]);
      const dohAddresses = dohResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      dohReturnedAddresses ||= dohAddresses.length > 0;
      selected = dohAddresses.find(({ address, family }) => isPublicAddress(address, family));
      if (selected) break;
      dohError ??= dohResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )?.reason;
    }
    if (!selected && dohError) {
      throw new SsrfRequestError(getSafeOidcErrorCode(dohError) ?? "DOH_REQUEST_FAILED");
    }
    if (!selected) {
      throw new SsrfRequestError(dohReturnedAddresses ? "DOH_NO_PUBLIC_ADDRESS" : "DOH_NO_ANSWER");
    }
  }
  if (!selected) throw new SsrfRequestError("DNS_NO_PUBLIC_ADDRESS");
  if (selected.family !== 4 && selected.family !== 6) {
    throw new SsrfRequestError("DNS_UNSUPPORTED_ADDRESS_FAMILY");
  }
  return { address: selected.address, family: selected.family };
}

/** Fetch JSON over HTTPS while blocking private/non-public DNS targets and pinning the resolved IP. */
export async function requestJson(url: URL): Promise<JsonMap> {
  let address: ResolvedAddress;
  try {
    address = await resolvePublicAddress(url);
  } catch (error) {
    throw new SsrfRequestError(getSafeOidcErrorCode(error) ?? "DNS_OR_ADDRESS_REJECTED");
  }
  return requestJsonAtAddress(url, address);
}
