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
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  let body: { workspaceId?: string; organizationId?: string };
  try {
    body = (await request.json()) as { workspaceId?: string; organizationId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { workspaceId, organizationId } = body;
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required." }, { status: 400 });
  }

  const context = await getNanogresWorkspaceContext(session);
  if (context instanceof Response) return context;

  const targetOrgId = organizationId || context.organizationId;
  const targetWs = context.availableWorkspaces.find(
    (w) =>
      w.id.toLowerCase() === workspaceId.toLowerCase() &&
      w.organizationId.toLowerCase() === targetOrgId.toLowerCase(),
  );
  if (!targetWs) {
    return NextResponse.json(
      { error: "This workspace is not available to your Perminister account." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const res = NextResponse.json(
    {
      success: true,
      workspaceId,
      organizationId: targetOrgId,
      workspaceName: targetWs.name,
    },
    { headers: { "Cache-Control": "no-store" } },
  );

  res.cookies.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  if (targetOrgId) {
    res.cookies.set(ORGANIZATION_COOKIE, targetOrgId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return res;
}
