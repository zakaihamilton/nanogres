import type { Metadata } from "next";
import { LiveBackupsScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Backups · Nanogres" };

export default function BackupsPage() {
  return <LiveBackupsScreen page="list" />;
}
