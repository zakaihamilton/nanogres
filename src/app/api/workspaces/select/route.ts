import { handleWorkspaceMutation, workspaceSelectionResponse } from "@/lib/workspace-route-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleWorkspaceMutation(request, async ({ getWorkspaceContext }) => {
    let body: { workspaceId?: string; organizationId?: string };
    try {
      body = (await request.json()) as { workspaceId?: string; organizationId?: string };
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { workspaceId, organizationId } = body;
    if (!workspaceId) {
      return Response.json({ error: "workspaceId is required." }, { status: 400 });
    }

    const context = await getWorkspaceContext();
    if (context instanceof Response) return context;

    const targetOrgId = organizationId || context.organizationId;
    const targetWs = context.availableWorkspaces.find(
      (w) =>
        w.id.toLowerCase() === workspaceId.toLowerCase() &&
        w.organizationId.toLowerCase() === targetOrgId.toLowerCase(),
    );
    if (!targetWs) {
      return Response.json(
        { error: "This workspace is not available to your Perminister account." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    return workspaceSelectionResponse(
      {
        success: true,
        workspaceId,
        organizationId: targetOrgId,
        workspaceName: targetWs.name,
      },
      workspaceId,
      targetOrgId,
    );
  });
}
