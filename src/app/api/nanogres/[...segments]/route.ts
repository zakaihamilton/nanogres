import { NextRequest } from "next/server";
import { authorizeNanogresAction } from "@/lib/perminister-auth";
import { callNanogresApi, relayApiResponse } from "@/lib/nanogres-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteParams = { params: Promise<{ segments: string[] }> };

function actionFor(method: string, segments: string[]): string | null {
  const [resource, identifier] = segments;
  const productId = process.env.PERMINISTER_PRODUCT_ID?.trim().toLowerCase();
  if (!productId) return null;
  const read = `${productId}:workspace:read`;
  const manage = `${productId}:members:manage`;
  if (method === "GET") {
    if (["overview", "databases", "roles", "backups", "activity"].includes(resource)) return read;
  }
  if (method === "POST") {
    if (["databases", "roles", "backups", "restore-uploads"].includes(resource)) return manage;
  }
  if (method === "PUT" && resource === "restore-uploads" && identifier) return manage;
  if (method === "DELETE" && resource === "databases" && identifier) return manage;
  if (method === "DELETE" && resource === "restore-uploads" && identifier) return manage;
  return null;
}

function apiPath(segments: string[]): string {
  return `/v1/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

async function handle(request: NextRequest, context: RouteParams): Promise<Response> {
  const { segments } = await context.params;
  const action = actionFor(request.method, segments);
  if (!action) {
    return Response.json({ error: "Route not found." }, { status: 404 });
  }

  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const appOrigin = process.env.NANOGRES_APP_ORIGIN?.replace(/\/$/, "");
    if (!origin || !appOrigin || origin !== appOrigin) {
      return Response.json({ error: "Request origin is not allowed." }, { status: 403 });
    }
  }

  const auth = await authorizeNanogresAction(action);
  if (auth instanceof Response) return auth;

  let body: BodyInit | undefined;
  if (request.method === "POST") {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 8192)
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
    }
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 8192) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    try {
      JSON.parse(body);
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
  }

  if (request.method === "PUT") {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/octet-stream") {
      return Response.json(
        { error: "Content-Type must be application/octet-stream." },
        { status: 415 },
      );
    }
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 4 * 1024 * 1024) {
      return Response.json({ error: "Upload chunk is too large." }, { status: 413 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) {
      return Response.json({ error: "Upload chunk has an invalid size." }, { status: 413 });
    }
    body = bytes;
  }

  let upstreamPath = apiPath(segments);
  if (request.method === "GET" && segments[0] === "backups" && segments[1]) {
    const query = request.nextUrl.searchParams;
    const offset = query.get("offset");
    const length = query.get("length");
    const keys = Array.from(query.keys());
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== "offset" && key !== "length") ||
      !offset ||
      !length ||
      !/^\d+$/.test(offset) ||
      !/^\d+$/.test(length)
    ) {
      return Response.json({ error: "Specify one download offset and length." }, { status: 400 });
    }
    upstreamPath +=
      "?offset=" + encodeURIComponent(offset) + "&length=" + encodeURIComponent(length);
  }

  const contentType =
    request.method === "PUT"
      ? "application/octet-stream"
      : request.method === "POST"
        ? "application/json"
        : undefined;
  const upstream = await callNanogresApi(upstreamPath, auth.session, {
    method: request.method,
    ...(body === undefined
      ? {}
      : { body, headers: { "Content-Type": contentType ?? "application/json" } }),
  });
  return relayApiResponse(upstream);
}

export function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  return handle(request, context);
}

export function POST(request: NextRequest, context: RouteParams): Promise<Response> {
  return handle(request, context);
}

export function PUT(request: NextRequest, context: RouteParams): Promise<Response> {
  return handle(request, context);
}

export function DELETE(request: NextRequest, context: RouteParams): Promise<Response> {
  return handle(request, context);
}
