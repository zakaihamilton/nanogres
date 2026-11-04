import type { Metadata } from "next";
import { LiveBackupsScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Restore backup" };

export default function Page() {
  return <LiveBackupsScreen page="restore" />;
}
