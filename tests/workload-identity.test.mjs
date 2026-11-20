import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "virtual:server-only", shortCircuit: true };
    }
    if (specifier === "node:dns/promises") {
      return { url: "virtual:oidc-dns", shortCircuit: true };
    }
    if (specifier === "node:https") {
      return { url: "virtual:oidc-https", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "virtual:server-only") {
      return { format: "module", shortCircuit: true, source: "" };
    }
    if (url === "virtual:oidc-dns") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export async function lookup() {
            return [{ address: "93.184.216.34", family: 4 }];
          }
          export class Resolver {
            constructor() {}
            async resolve4() { return ["93.184.216.34"]; }
            async resolve6() { return []; }
          }
        `,
      };
    }
    if (url === "virtual:oidc-https") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { EventEmitter } from "node:events";
          export function request(url, options, callback) {
            const request = new EventEmitter();
            request.end = () => {
              globalThis.fetch(url, { redirect: "error", signal: options.signal })
                .then(async (response) => {
                  const body = Buffer.from(await response.arrayBuffer());
                  const result = new EventEmitter();
                  result.statusCode = response.status;
                  result.headers = { "content-length": String(body.byteLength) };
                  result.resume = () => {};
                  result.destroy = (error) => {
                    if (error) result.emit("error", error);
                  };
                  callback(result);
                  queueMicrotask(() => {
                    result.emit("data", body);
                    result.emit("end");
                  });
                })
                .catch((error) => request.emit("error", error));
            };
            return request;
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { verifyWorkloadIdentityToken } = await import("../src/lib/workload-identity.ts");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "workload-test-key",
  use: "sig",
};

const issuer = "https://oidc.example.test/team";
const grant = {
  id: "0123456789abcdef0123456789abcdef",
  issuer,
  audience: "https://nanogres.example.test",
  subject: "owner:team:project:visitoring:environment:production",
  database: "visitoring",
  role: "app_runtime",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createSignedJwt(payloadOverrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({
    alg: "RS256",
    typ: "JWT",
    kid: "workload-test-key",
    ...headerOverrides,
  });
  const payload = encode({
    iss: grant.issuer,
    aud: grant.audience,
    sub: grant.subject,
    iat: now - 10,
    exp: now + 300,
    ...payloadOverrides,
  });
  const input = `${header}.${payload}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(input, "utf8"), privateKey).toString(
    "base64url",
  );
  return `${input}.${signature}`;
}

function mockOidcFetch(keys = [publicJwk]) {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === `${issuer}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "Content-Type": "application/jwk-set+json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };
}

test("accepts a valid RS256 OIDC workload token matching the grant", async () => {
  mockOidcFetch();
  const token = createSignedJwt();
  assert.equal(await verifyWorkloadIdentityToken(token, grant), true);
});

test("rejects expired, mismatched, or tampered workload tokens", async () => {
  mockOidcFetch();
  const now = Math.floor(Date.now() / 1000);

  assert.equal(
    await verifyWorkloadIdentityToken(createSignedJwt({ iat: now - 600, exp: now - 60 }), grant),
    false,
  );
  assert.equal(
    await verifyWorkloadIdentityToken(createSignedJwt({ iss: "https://other.example.test" }), grant),
    false,
  );
  assert.equal(
    await verifyWorkloadIdentityToken(createSignedJwt({ aud: "https://wrong.example.test" }), grant),
    false,
  );
  assert.equal(
    await verifyWorkloadIdentityToken(createSignedJwt({ sub: "other-subject" }), grant),
    false,
  );

  const valid = createSignedJwt();
  const [header, payload, signature] = valid.split(".");
  const tampered = `${header}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(await verifyWorkloadIdentityToken(tampered, grant), false);
  assert.equal(
    await verifyWorkloadIdentityToken(createSignedJwt({}, { kid: "unknown-key" }), grant),
    false,
  );
});

test("rejects forbidden JWT headers and non-HTTPS issuers", async () => {
  mockOidcFetch();
  assert.equal(
    await verifyWorkloadIdentityToken(
      createSignedJwt({}, { jku: "https://evil.example/jwks.json" }),
      grant,
    ),
    false,
  );
  assert.equal(
    await verifyWorkloadIdentityToken(
      createSignedJwt({}, { x5u: "https://evil.example/cert.pem" }),
      grant,
    ),
    false,
  );
  assert.equal(
    await verifyWorkloadIdentityToken(createSignedJwt({}, { crit: ["exp"] }), grant),
    false,
  );
  assert.equal(
    await verifyWorkloadIdentityToken(createSignedJwt(), {
      ...grant,
      issuer: "http://oidc.example.test/team",
    }),
    false,
  );
});
