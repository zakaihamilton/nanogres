import { NextRequest, NextResponse } from "next/server";
import {
  getAppOrigin,
  getCurrentPerministerSession,
  LEGACY_WORKSPACE_COOKIE,
  LEGACY_WORKSPACE_NAMES_COOKIE,
  nanogresOrganizations,
  ORGANIZATION_COOKIE,
} from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const appOrigin = getAppOrigin();
  if (!appOrigin || request.headers.get("origin") !== appOrigin) {
    return Response.json({ error: "Request origin is not allowed." }, { status: 403 });
  }

  const session = await getCurrentPerministerSession();
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Provide an organizationId." }, { status: 400 });
  }
  const organizationId =
    typeof body === "object" && body !== null && !Array.isArray(body) &&
    "organizationId" in body && typeof body.organizationId === "string"
      ? body.organizationId.trim().toLowerCase()
      : "";
  if (!organizationId) {
    return Response.json({ error: "Provide an organizationId." }, { status: 400 });
  }
  const organization = nanogresOrganizations(session).find(
    (item) => item.organizationId === organizationId,
  );
  if (!organization) {
    return Response.json(
      { error: "This organization is not available to your Perminister account." },
      { status: 403 },
    );
  }

  const response = NextResponse.json(
    { selected: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };
  response.cookies.set(ORGANIZATION_COOKIE, organization.organizationId, cookieOptions);
  response.cookies.set(LEGACY_WORKSPACE_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  response.cookies.set(LEGACY_WORKSPACE_NAMES_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  return response;
}
