import { NextRequest, NextResponse } from "next/server";
import {
  getAppOrigin,
  getCurrentPerministerSession,
  getNanogresWorkspaceContext,
  ORGANIZATION_COOKIE,
  WORKSPACE_COOKIE,
} from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const appOrigin = getAppOrigin();
  if (!appOrigin || request.headers.get("origin") !== appOrigin) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }

  const session = await getCurrentPerministerSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  let body: { organizationId?: string; workspaceId?: string } = {};
  try {
    body = (await request.json()) as { organizationId?: string; workspaceId?: string };
  } catch {
    // empty body is fine
  }

  const context = await getNanogresWorkspaceContext(session);
  if (context instanceof Response) return context;

  const organizationId = body.organizationId || context.organizationId;
  const workspaceId = body.workspaceId || context.workspaceId;
  const { config } = context;

  try {
    const response = await fetch(`${config.baseUrl}/api/auth/consumer/workspaces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        "X-Perminister-Client-Id": config.clientId,
        "X-Perminister-Client-Secret": config.clientSecret,
      },
      body: JSON.stringify({ organizationId, workspaceId }),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (response.ok) {
      const result = NextResponse.json(
        { granted: true, workspaceId, organizationId },
        { headers: { "Cache-Control": "no-store" } },
      );
      result.cookies.set(WORKSPACE_COOKIE, workspaceId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      result.cookies.set(ORGANIZATION_COOKIE, organizationId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
      return result;
    }
    if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        {
          error:
            "Perminister requires an organization owner or admin to initialize this workspace.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Perminister is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Perminister is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
