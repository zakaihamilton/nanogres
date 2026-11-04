import "server-only";

import type { CurrentSession } from "@/lib/perminister-auth";

type WorkspaceApiTarget = { organizationId: string; workspaceId: string };
type ApiConfig = { url: string; token: string };

function parseApiConfig(rawUrl?: string, rawToken?: string): ApiConfig | null {
  const urlValue = rawUrl?.trim();
  const token = rawToken?.trim();
  if (!urlValue || !token) return null;
  try {
    const url = new URL(urlValue);
    const localHttp =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return { url: url.origin + url.pathname.replace(/\/$/, ""), token };
  } catch {
    return null;
  }
}

function getApiConfig(target: WorkspaceApiTarget): ApiConfig | null {
  const configuredOrganization = process.env.PERMINISTER_ORGANIZATION_ID?.trim().toLowerCase();
  const configuredWorkspace = process.env.NANOGRES_WORKSPACE_ID?.trim().toLowerCase();
  if (
    !configuredOrganization ||
    !configuredWorkspace ||
    target.organizationId.trim().toLowerCase() !== configuredOrganization ||
    target.workspaceId.trim().toLowerCase() !== configuredWorkspace
  ) {
    return null;
  }

  return parseApiConfig(process.env.NANOGRES_API_URL, process.env.NANOGRES_API_TOKEN);
}

function apiNotConfigured(): Response {
  return Response.json(
    { error: "The workspace service is not configured for the selected workspace." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function callNanogresApi(
  path: string,
  session: CurrentSession,
  target: WorkspaceApiTarget,
  init: RequestInit = {},
): Promise<Response> {
  const config = getApiConfig(target);
  if (!config) return apiNotConfigured();
  const longRunningPost =
    init.method === "POST" &&
    (path.startsWith("/v1/backups") || /\/restore-uploads\/[a-f0-9]{32}\/complete$/.test(path));
  const timeout = path === "/v1/events/stream" ? 295_000 : longRunningPost ? 255_000 : 60_000;
  try {
    return await fetch(`${config.url}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${config.token}`,
        "X-Nanogres-Actor": session.account.subjectId,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return Response.json(
      { error: "The Nanogres workspace service could not be reached." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function relayApiResponse(upstream: Response): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (upstream.headers.get("content-type")) {
    headers.set("Content-Type", upstream.headers.get("content-type")!);
  }
  if (upstream.headers.get("content-disposition")) {
    headers.set("Content-Disposition", upstream.headers.get("content-disposition")!);
  }
  if (upstream.headers.get("content-length")) {
    headers.set("Content-Length", upstream.headers.get("content-length")!);
  }
  if (upstream.headers.get("content-range")) {
    headers.set("Content-Range", upstream.headers.get("content-range")!);
  }
  if (upstream.headers.get("accept-ranges")) {
    headers.set("Accept-Ranges", upstream.headers.get("accept-ranges")!);
  }
  if (upstream.status >= 500) {
    return Response.json(
      { error: "The Nanogres workspace service failed to complete the request." },
      { status: upstream.status, headers },
    );
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
