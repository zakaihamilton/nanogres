import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { getCurrentPerministerSession } from "@/lib/perminister-auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getCurrentPerministerSession();
  if (!session) redirect("/login");

  const name = [session.account.firstName, session.account.lastName].filter(Boolean).join(" ");
  const displayName = name || session.account.username || session.account.email || "Nanogres user";

  return (
    <DashboardShell
      account={{ name: displayName, email: session.account.email ?? "Perminister account" }}
    >
      {children}
    </DashboardShell>
  );
}
