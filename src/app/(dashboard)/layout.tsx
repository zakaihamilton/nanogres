import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { getCurrentPerministerSession, getNanogresWorkspaceContext } from "@/lib/perminister-auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getCurrentPerministerSession();
  if (!session) redirect("/login");

  const name = [session.account.firstName, session.account.lastName].filter(Boolean).join(" ");
  const displayName = name || session.account.username || session.account.email || "Nanogres user";

  const context = await getNanogresWorkspaceContext(session);
  const currentWorkspace = !(context instanceof Response)
    ? { id: context.workspaceId, name: context.workspaceName }
    : undefined;
  const currentOrganization = !(context instanceof Response)
    ? { id: context.organizationId, name: context.organizationName }
    : undefined;
  const workspaces = !(context instanceof Response) ? context.availableWorkspaces : [];

  return (
    <DashboardShell
      account={{ name: displayName, email: session.account.email ?? "Perminister account" }}
      currentOrganization={currentOrganization}
      currentWorkspace={currentWorkspace}
      workspaces={workspaces}
    >
      {children}
    </DashboardShell>
  );
}
