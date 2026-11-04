import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentPerministerSession, getNanogresWorkspaceContext } from "@/lib/perminister-auth";
import { WorkspacesClient } from "./workspaces-client";

export const metadata: Metadata = { title: "Workspaces · Nanogres" };
export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const session = await getCurrentPerministerSession();
  if (!session) redirect("/login");

  const context = await getNanogresWorkspaceContext(session);
  if (context instanceof Response) {
    redirect("/overview");
  }

  return (
    <WorkspacesClient
      currentOrganizationId={context.organizationId}
      currentOrganizationName={context.organizationName}
      currentWorkspaceId={context.workspaceId}
      role={context.role}
      workspaces={context.availableWorkspaces}
    />
  );
}
