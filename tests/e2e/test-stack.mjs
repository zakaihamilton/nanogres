import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appOrigin = "http://127.0.0.1:3100";
const identityOrigin = "http://127.0.0.1:4311";
const apiOrigin = "http://127.0.0.1:4312";
const clientId = "nanogres-e2e-client";
const clientSecret = "test-only-secret-not-used-outside-loopback";
const sessionToken = "nanogres-e2e-session";
const apiToken = "nanogres-e2e-api-token-not-for-production";
const organizationId = "e2e-organization";
const productId = "nanogres";
const workspaceId = "e2e-workspace";
const chunkSizeBytes = 16;
const syntheticDump = Buffer.from("Nanogres isolated browser-test dump fixture.".padEnd(64, "."));

let identityState;
let apiState;
let uploadSequence = 0;
const oauthCodes = new Map();

function resetIdentityState() {
  identityState = { bootstrapRequired: false, deniedAction: null };
  oauthCodes.clear();
}

function database(name, systemDatabase = false) {
  return {
    name,
    owner: "postgres",
    sizeBytes: 1024,
    connections: 0,
    maxConnections: 100,
    encoding: "UTF8",
    systemDatabase,
    growthHeadroomBytes: 64 * 1024 * 1024,
    recommendedMaxBytes: 64 * 1024 * 1024,
    quotaUsedBytes: 1024,
    hardLimitEnforced: false,
    quotaMode: "auto",
    requestedMaxBytes: null,
    maximumCustomMaxBytes: 64 * 1024 * 1024,
    quotaConstrained: false,
  };
}

function resetApiState() {
  apiState = {
    databases: [database("postgres", true), database("app_main")],
    roles: [
      {
        name: "postgres",
        superuser: true,
        canCreateDatabase: true,
        canCreateRole: true,
        validUntil: null,
        systemRole: true,
      },
      {
        name: "app_reader",
        superuser: false,
        canCreateDatabase: false,
        canCreateRole: false,
        validUntil: null,
        systemRole: false,
      },
    ],
    backups: [],
    events: [],
    uploads: new Map(),
    options: { failReads: false, failNextUploadChunk: false, offsiteBackup: null },
  };
  uploadSequence = 0;
}

resetIdentityState();
resetApiState();

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJson(request) {
  const body = await readBody(request);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

function hasClientHeaders(request) {
  return (
    request.headers["x-perminister-client-id"] === clientId &&
    request.headers["x-perminister-client-secret"] === clientSecret
  );
}

function hasSession(request) {
  return request.headers.authorization === `Bearer ${sessionToken}`;
}

function identityPayload() {
  return {
    authenticated: true,
    account: {
      subjectId: "e2e-user-1",
      email: "nanogres-e2e@example.test",
      username: "nanogres-e2e",
      firstName: "Test",
      lastName: "Admin",
    },
    session: {
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    organizations: [
      {
        organizationId,
        organizationName: "Nanogres E2E",
        productId,
        permissions: [],
      },
    ],
  };
}

function sessionGrant() {
  return {
    authenticated: true,
    sessionToken,
    session: { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  };
}

async function identityHandler(request, response) {
  const url = new URL(request.url, identityOrigin);
  if (url.pathname === "/__test__/reset" && request.method === "POST") {
    resetIdentityState();
    sendJson(response, 200, { reset: true });
    return;
  }
  if (url.pathname === "/__test__/configure" && request.method === "POST") {
    const value = await readJson(request);
    identityState = { ...identityState, ...value };
    sendJson(response, 200, { updated: true });
    return;
  }
  if (url.pathname === "/oauth/authorize" && request.method === "GET") {
    if (
      url.searchParams.get("client_id") !== clientId ||
      url.searchParams.get("code_challenge_method") !== "S256"
    ) {
      sendJson(response, 400, { error: "Invalid test OAuth request." });
      return;
    }
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (new URL(redirectUri).origin !== appOrigin) {
      sendJson(response, 400, { error: "Unexpected test callback origin." });
      return;
    }
    const values = Object.fromEntries(url.searchParams.entries());
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><title>Local Perminister test</title></head>
      <body><main><h1>Perminister test sign-in</h1>
      <p>This local identity provider is reserved for isolated Nanogres browser tests.</p>
      <form action="/oauth/authorize/continue" method="post">
        ${Object.entries(values)
          .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
          .join("\n")}
        <button type="submit">Continue as test admin</button>
      </form></main></body></html>`);
    return;
  }
  if (url.pathname === "/oauth/authorize/continue" && request.method === "POST") {
    const form = new URLSearchParams((await readBody(request)).toString("utf8"));
    const code = randomBytes(24).toString("base64url");
    oauthCodes.set(code, {
      challenge: form.get("code_challenge"),
      redirectUri: form.get("redirect_uri"),
      state: form.get("state"),
    });
    const callback = new URL(form.get("redirect_uri"));
    callback.search = new URLSearchParams({ code, state: form.get("state") ?? "" }).toString();
    response.writeHead(303, { Location: callback.toString(), "Cache-Control": "no-store" });
    response.end();
    return;
  }
  if (url.pathname === "/api/auth/consumer/token" && request.method === "POST") {
    if (!hasClientHeaders(request)) {
      sendJson(response, 401, { error: "Test client credentials are invalid." });
      return;
    }
    const body = await readJson(request);
    const code = oauthCodes.get(body.code);
    const challenge = createHash("sha256")
      .update(String(body.code_verifier ?? ""))
      .digest("base64url");
    if (!code || code.challenge !== challenge || body.grant_type !== "authorization_code") {
      sendJson(response, 400, { error: "Invalid test OAuth code or verifier." });
      return;
    }
    oauthCodes.delete(body.code);
    sendJson(response, 200, sessionGrant());
    return;
  }
  if (url.pathname === "/api/auth/consumer/login" && request.method === "POST") {
    if (!hasClientHeaders(request)) {
      sendJson(response, 401, { error: "Test client credentials are invalid." });
      return;
    }
    const body = await readJson(request);
    if (
      body.identifier !== "nanogres-e2e@example.test" ||
      body.password !== "test-only-password-for-browser-tests"
    ) {
      sendJson(response, 401, { error: "Invalid test credentials." });
      return;
    }
    sendJson(response, 200, sessionGrant());
    return;
  }
  if (url.pathname === "/api/auth/consumer/session" && request.method === "GET") {
    sendJson(
      response,
      hasClientHeaders(request) && hasSession(request) ? 200 : 401,
      identityPayload(),
    );
    return;
  }
  if (url.pathname === "/api/auth/consumer/session" && request.method === "DELETE") {
    response.writeHead(hasClientHeaders(request) && hasSession(request) ? 204 : 401);
    response.end();
    return;
  }
  if (url.pathname === "/api/auth/consumer/workspaces" && request.method === "POST") {
    if (!hasClientHeaders(request) || !hasSession(request)) {
      sendJson(response, 401, { error: "Test session is invalid." });
      return;
    }
    const body = await readJson(request);
    if (body.organizationId !== organizationId || body.workspaceId !== workspaceId) {
      sendJson(response, 400, { error: "Unexpected test workspace." });
      return;
    }
    identityState.bootstrapRequired = false;
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/api/authorize" && request.method === "POST") {
    if (!hasClientHeaders(request) || !hasSession(request)) {
      sendJson(response, 401, { authorized: false });
      return;
    }
    const body = await readJson(request);
    const correctWorkspace =
      body.organizationId === organizationId &&
      body.productId === productId &&
      body.resourceKind === "workspace" &&
      body.resourceId === workspaceId;
    if (!correctWorkspace) {
      sendJson(response, 403, { authorized: false });
      return;
    }
    if (identityState.bootstrapRequired || identityState.deniedAction === body.action) {
      sendJson(response, 403, { authorized: false });
      return;
    }
    sendJson(response, 200, { authorized: true });
    return;
  }
  sendJson(response, 404, { error: "Test identity route not found." });
}

function status() {
  return {
    postgresVersion: "16.4 (isolated test service)",
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    connections: 1,
    maxConnections: 100,
    disk: { totalBytes: 240 * 1024 ** 3, usedBytes: 200 * 1024 ** 3, freeBytes: 40 * 1024 ** 3 },
    backupRetentionDays: 14,
    databaseGrowthPercent: 25,
    databaseQuotaReserveBytes: 1024 ** 3,
    databaseQuotaEnforced: false,
    databaseQuotaReason: null,
    databaseQuotaCheckedAt: null,
    offsiteBackup: apiState.options.offsiteBackup ?? {
      configured: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastSuccessAgeSeconds: null,
      backupCount: 0,
      storedBytes: 0,
      lastError: null,
      freshness: "not-configured",
    },
  };
}

function record(action, detail) {
  apiState.events.unshift({
    action,
    detail,
    actor: "e2e-user-1",
    createdAt: new Date().toISOString(),
  });
}

function ensureNewDatabase(name) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name ?? "")) return "invalid";
  if (apiState.databases.some((item) => item.name === name)) return "exists";
  apiState.databases.push(database(name));
  return "created";
}

async function apiHandler(request, response) {
  const url = new URL(request.url, apiOrigin);
  if (url.pathname === "/__test__/reset" && request.method === "POST") {
    resetApiState();
    sendJson(response, 200, { reset: true });
    return;
  }
  if (url.pathname === "/__test__/configure" && request.method === "POST") {
    apiState.options = { ...apiState.options, ...(await readJson(request)) };
    sendJson(response, 200, { updated: true });
    return;
  }
  if (url.pathname === "/__test__/state" && request.method === "GET") {
    sendJson(response, 200, {
      databaseNames: apiState.databases.map((item) => item.name),
      roleNames: apiState.roles.map((item) => item.name),
      backupCount: apiState.backups.length,
      uploadCount: apiState.uploads.size,
    });
    return;
  }
  if (!url.pathname.startsWith("/v1/")) {
    sendJson(response, 404, { error: "Test API route not found." });
    return;
  }
  if (request.headers.authorization !== `Bearer ${apiToken}`) {
    sendJson(response, 401, { error: "Test API token is invalid." });
    return;
  }
  if (apiState.options.failReads && request.method === "GET") {
    sendJson(response, 503, { error: "Synthetic test outage." });
    return;
  }

  const pathname = decodeURIComponent(url.pathname);
  if (request.method === "GET" && pathname === "/v1/overview") {
    sendJson(response, 200, {
      status: status(),
      databases: apiState.databases,
      backups: apiState.backups.slice(0, 8),
      activity: apiState.events.slice(0, 8),
    });
    return;
  }
  if (request.method === "GET" && pathname === "/v1/databases") {
    sendJson(response, 200, { status: status(), databases: apiState.databases });
    return;
  }
  if (request.method === "GET" && pathname === "/v1/roles") {
    sendJson(response, 200, { roles: apiState.roles });
    return;
  }
  if (request.method === "GET" && pathname === "/v1/backups") {
    sendJson(response, 200, { backups: apiState.backups });
    return;
  }
  if (request.method === "GET" && pathname === "/v1/activity") {
    sendJson(response, 200, { events: apiState.events });
    return;
  }
  if (request.method === "GET" && pathname.startsWith("/v1/backups/")) {
    const filename = pathname.slice("/v1/backups/".length);
    const backup = apiState.backups.find((item) => item.filename === filename);
    const content = backup?.content;
    const offset = Number(url.searchParams.get("offset"));
    const length = Number(url.searchParams.get("length"));
    if (!content || !Number.isInteger(offset) || !Number.isInteger(length)) {
      sendJson(response, 404, { error: "Backup not found." });
      return;
    }
    const chunk = content.subarray(offset, offset + length);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(chunk.byteLength),
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    response.end(chunk);
    return;
  }
  if (request.method === "POST" && pathname === "/v1/databases") {
    const body = await readJson(request);
    const result = ensureNewDatabase(body.name);
    if (result === "invalid") return sendJson(response, 400, { error: "Invalid database name." });
    if (result === "exists") return sendJson(response, 409, { error: "Database already exists." });
    record("database.created", `Database ${body.name} created.`);
    return sendJson(response, 201, {
      database: apiState.databases.find((item) => item.name === body.name),
    });
  }
  if (request.method === "DELETE" && pathname.startsWith("/v1/databases/")) {
    const name = pathname.slice("/v1/databases/".length);
    if (name === "postgres")
      return sendJson(response, 400, { error: "System databases cannot be removed." });
    const index = apiState.databases.findIndex((item) => item.name === name);
    if (index < 0) return sendJson(response, 404, { error: "Database not found." });
    apiState.databases.splice(index, 1);
    record("database.deleted", `Database ${name} deleted.`);
    return sendJson(response, 200, { deleted: true });
  }
  if (request.method === "POST" && pathname === "/v1/roles") {
    const body = await readJson(request);
    if (
      !/^[a-z][a-z0-9_]{1,62}$/.test(body.name ?? "") ||
      !apiState.databases.some((item) => item.name === body.database)
    ) {
      return sendJson(response, 400, { error: "Role name or database is invalid." });
    }
    if (apiState.roles.some((item) => item.name === body.name)) {
      return sendJson(response, 409, { error: "Role already exists." });
    }
    const role = {
      name: body.name,
      superuser: false,
      canCreateDatabase: false,
      canCreateRole: false,
      validUntil: null,
      systemRole: false,
    };
    apiState.roles.push(role);
    record("role.created", `Role ${body.name} created for ${body.database}.`);
    return sendJson(response, 201, { role });
  }
  if (request.method === "POST" && pathname === "/v1/backups") {
    const body = await readJson(request);
    if (!apiState.databases.some((item) => item.name === body.database)) {
      return sendJson(response, 404, { error: "Database not found." });
    }
    const filename = `${body.database}__20261104T120000000000Z.dump`;
    const backup = {
      filename,
      database: body.database,
      createdAt: new Date().toISOString(),
      sizeBytes: syntheticDump.byteLength,
      content: syntheticDump,
    };
    apiState.backups.unshift(backup);
    record("backup.created", `Backup created for ${body.database}.`);
    return sendJson(response, 201, { backup: { ...backup, content: undefined } });
  }
  if (
    request.method === "POST" &&
    pathname.startsWith("/v1/backups/") &&
    pathname.endsWith("/restore")
  ) {
    const filename = pathname.slice("/v1/backups/".length, -"/restore".length);
    const backup = apiState.backups.find((item) => item.filename === filename);
    if (!backup) return sendJson(response, 404, { error: "Backup not found." });
    const body = await readJson(request);
    const result = ensureNewDatabase(body.database);
    if (result !== "created")
      return sendJson(response, result === "exists" ? 409 : 400, {
        error: "Choose a new database name.",
      });
    record("backup.restored", `Restored ${filename} as ${body.database}.`);
    return sendJson(response, 201, { database: body.database });
  }
  if (request.method === "POST" && pathname === "/v1/restore-uploads") {
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 1) {
      return sendJson(response, 400, { error: "Choose a non-empty PostgreSQL dump file." });
    }
    uploadSequence += 1;
    const uploadId = uploadSequence.toString(16).padStart(32, "0");
    const chunkCount = Math.ceil(body.sizeBytes / chunkSizeBytes);
    apiState.uploads.set(uploadId, { sizeBytes: body.sizeBytes, chunkCount, chunks: new Map() });
    return sendJson(response, 201, { uploadId, chunkSizeBytes, chunkCount });
  }
  const chunkMatch = pathname.match(/^\/v1\/restore-uploads\/([a-f0-9]{32})\/chunks\/(\d+)$/);
  if (request.method === "PUT" && chunkMatch) {
    if (apiState.options.failNextUploadChunk) {
      apiState.options.failNextUploadChunk = false;
      return sendJson(response, 503, { error: "Synthetic interrupted upload." });
    }
    const upload = apiState.uploads.get(chunkMatch[1]);
    if (!upload) return sendJson(response, 404, { error: "Upload not found." });
    const index = Number(chunkMatch[2]);
    const chunk = await readBody(request);
    if (index >= upload.chunkCount || chunk.byteLength < 1 || chunk.byteLength > chunkSizeBytes) {
      return sendJson(response, 400, { error: "Invalid upload chunk." });
    }
    upload.chunks.set(index, chunk);
    return sendJson(response, 200, {
      chunk: { chunkIndex: index, receivedBytes: chunk.byteLength },
    });
  }
  if (
    request.method === "POST" &&
    pathname.startsWith("/v1/restore-uploads/") &&
    pathname.endsWith("/complete")
  ) {
    const uploadId = pathname.slice("/v1/restore-uploads/".length, -"/complete".length);
    const upload = apiState.uploads.get(uploadId);
    const body = await readJson(request);
    if (!upload || upload.chunks.size !== upload.chunkCount) {
      return sendJson(response, 400, { error: "The uploaded backup is incomplete." });
    }
    const content = Buffer.concat(
      Array.from(
        { length: upload.chunkCount },
        (_, index) => upload.chunks.get(index) ?? Buffer.alloc(0),
      ),
    );
    if (content.byteLength !== upload.sizeBytes) {
      return sendJson(response, 400, { error: "The uploaded backup has an invalid size." });
    }
    const result = ensureNewDatabase(body.database);
    if (result !== "created")
      return sendJson(response, result === "exists" ? 409 : 400, {
        error: "Choose a new database name.",
      });
    apiState.uploads.delete(uploadId);
    record("backup.restored", `Uploaded backup restored as ${body.database}.`);
    return sendJson(response, 201, { database: body.database });
  }
  if (request.method === "DELETE" && pathname.startsWith("/v1/restore-uploads/")) {
    const uploadId = pathname.slice("/v1/restore-uploads/".length);
    apiState.uploads.delete(uploadId);
    return sendJson(response, 200, { deleted: true });
  }
  sendJson(response, 404, { error: "Test VPS API route not found." });
}

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: "Test service failed." });
        else response.destroy();
      });
    });
    server.once("error", reject);
    server.listen(
      Number(new URL(handler === identityHandler ? identityOrigin : apiOrigin).port),
      "127.0.0.1",
      () => {
        server.off("error", reject);
        resolve(server);
      },
    );
  });
}

const identityServer = await startServer(identityHandler);
const apiServer = await startServer(apiHandler);
const environment = {
  ...process.env,
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  WATCHPACK_POLLING: "true",
  PERMINISTER_URL: identityOrigin,
  PERMINISTER_APP_CLIENT_ID: clientId,
  PERMINISTER_APP_CLIENT_SECRET: clientSecret,
  PERMINISTER_CLIENT_ID: clientId,
  PERMINISTER_CLIENT_SECRET: clientSecret,
  PERMINISTER_PRODUCT_ID: productId,
  NANOGRES_APP_ORIGIN: appOrigin,
  NANOGRES_API_URL: apiOrigin,
  NANOGRES_API_TOKEN: apiToken,
};
const nextBin = path.join(repositoryRoot, "node_modules/next/dist/bin/next");
const next = spawn(
  process.execPath,
  [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3100"],
  {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  },
);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (next.pid && next.exitCode === null) {
    next.kill("SIGTERM");
  }
  identityServer.close();
  apiServer.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
next.once("exit", (code) => {
  stop();
  process.exitCode = code ?? 1;
});

console.log(
  "Isolated E2E services ready: local Perminister, local VPS API, and Next.js at port 3100.",
);
