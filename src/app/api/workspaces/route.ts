import { NextResponse } from "next/server";
import { getCurrentPerministerSession, getNanogresWorkspaceContext } from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const session = await getCurrentPerministerSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const context = await getNanogresWorkspaceContext(session);
  if (context instanceof Response) return context;

  return NextResponse.json(
    {
      currentWorkspaceId: context.workspaceId,
      currentWorkspaceName: context.workspaceName,
      currentOrganizationId: context.organizationId,
      currentOrganizationName: context.organizationName,
      role: context.role,
      workspaces: context.availableWorkspaces,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
