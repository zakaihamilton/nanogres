import { NextResponse } from "next/server";
import {
  getAppOrigin,
  getCurrentPerministerSession,
  getNanogresWorkspaceContext,
  ORGANIZATION_COOKIE,
  WORKSPACE_COOKIE,
} from "@/lib/perminister-auth";
export { registerPerministerWorkspace } from "@/lib/perminister-auth";

type Session = NonNullable<Awaited<ReturnType<typeof getCurrentPerministerSession>>>;
type WorkspaceContext = Awaited<ReturnType<typeof getNanogresWorkspaceContext>>;

export async function handleWorkspaceMutation(
  request: Request,
  action: (authorization: {
    session: Session;
    getWorkspaceContext: () => Promise<WorkspaceContext>;
  }) => Promise<Response>,
): Promise<Response> {
  const appOrigin = getAppOrigin();
  if (!appOrigin || request.headers.get("origin") !== appOrigin) {
    return Response.json({ error: "Request origin is not allowed." }, { status: 403 });
  }

  const session = await getCurrentPerministerSession();
  if (!session) {
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  }

  return action({
    session,
    getWorkspaceContext: () => getNanogresWorkspaceContext(session),
  });
}

export function workspaceSelectionResponse(
  body: object,
  workspaceId: string,
  organizationId?: string,
): NextResponse {
  const response = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };

  response.cookies.set(WORKSPACE_COOKIE, workspaceId, cookieOptions);
  if (organizationId) response.cookies.set(ORGANIZATION_COOKIE, organizationId, cookieOptions);

  return response;
}
