import "server-only";

import type { CurrentSession } from "@/lib/perminister-auth";

function getApiConfig(): { url: string; token: string } | null {
  const rawUrl = process.env.NANOGRES_API_URL?.trim();
  const token = process.env.NANOGRES_API_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  try {
    const url = new URL(rawUrl);
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

function apiNotConfigured(): Response {
  return Response.json(
    { error: "The Nanogres VPS API is not configured." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function callNanogresApi(
  path: string,
  session: CurrentSession,
  init: RequestInit = {},
): Promise<Response> {
  const config = getApiConfig();
  if (!config) return apiNotConfigured();
  const longRunningPost =
    init.method === "POST" &&
    (path.startsWith("/v1/backups") || /\/restore-uploads\/[a-f0-9]{32}\/complete$/.test(path));
  const timeout = longRunningPost ? 255_000 : 60_000;
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
      { error: "The Nanogres VPS API could not be reached." },
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
      { error: "The Nanogres VPS API failed to complete the request." },
      { status: upstream.status, headers },
    );
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
