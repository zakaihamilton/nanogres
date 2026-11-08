import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import {
  getCurrentPerministerSession,
  getNanogresOrganizationContext,
} from "@/lib/perminister-auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getCurrentPerministerSession();
  if (!session) redirect("/login");

  const name = [session.account.firstName, session.account.lastName].filter(Boolean).join(" ");
  const displayName = name || session.account.username || session.account.email || "Nanogres user";

  const context = await getNanogresOrganizationContext(session);
  const currentOrganization = !(context instanceof Response)
    ? { id: context.organizationId, name: context.organizationName }
    : undefined;
  const organizations = !(context instanceof Response) ? context.availableOrganizations : [];

  return (
    <DashboardShell
      account={{ name: displayName, email: session.account.email }}
      currentOrganization={currentOrganization}
      organizations={organizations}
    >
      {children}
    </DashboardShell>
  );
}
