import type { Metadata } from "next";
import { LiveBackupsScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Restore backup" };

export default async function RestoreBackupPage({
  params,
}: {
  params: Promise<{ filename: string }>;
}) {
  const { filename } = await params;
  return <LiveBackupsScreen page="restore-existing" backupFilename={filename} />;
}
