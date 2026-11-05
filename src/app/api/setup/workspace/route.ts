import {
  handleWorkspaceMutation,
  registerPerministerWorkspace,
  workspaceSelectionResponse,
} from "@/lib/workspace-route-auth";
import { noStoreErrorResponse } from "@/lib/api-response";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleWorkspaceMutation(request, async ({ session, getWorkspaceContext }) => {
    let body: { organizationId?: string; workspaceId?: string } = {};
    try {
      body = (await request.json()) as { organizationId?: string; workspaceId?: string };
    } catch {
      // empty body is fine
    }

    const context = await getWorkspaceContext();
    if (context instanceof Response) return context;

    const organizationId = body.organizationId || context.organizationId;
    const workspaceId = body.workspaceId || context.workspaceId;
    const { config } = context;

    try {
      const response = await registerPerministerWorkspace(
        config,
        session,
        organizationId,
        workspaceId,
      );
      if (response.ok) {
        return workspaceSelectionResponse(
          { granted: true, workspaceId, organizationId },
          workspaceId,
          organizationId,
        );
      }
      if (response.status === 401 || response.status === 403) {
        return noStoreErrorResponse(
          "Perminister requires an organization owner or admin to initialize this workspace.",
          403,
        );
      }
      return noStoreErrorResponse("Perminister is temporarily unavailable.", 503);
    } catch {
      return noStoreErrorResponse("Perminister is temporarily unavailable.", 503);
    }
  });
}
