import { NextRequest } from "next/server";
import { authorizeNanogresAction } from "@/lib/perminister-auth";
import { callNanogresApi, relayApiResponse } from "@/lib/nanogres-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if (["databases", "roles", "backups"].includes(resource)) return manage;
  }
  if (method === "DELETE" && resource === "databases" && identifier) return manage;
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

  let body: string | undefined;
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

  const upstream = await callNanogresApi(apiPath(segments), auth.session, {
    method: request.method,
    ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }),
  });
  return relayApiResponse(upstream);
}

export function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  return handle(request, context);
}

export function POST(request: NextRequest, context: RouteParams): Promise<Response> {
  return handle(request, context);
}

export function DELETE(request: NextRequest, context: RouteParams): Promise<Response> {
  return handle(request, context);
}
