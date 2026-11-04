import type { Metadata } from "next";
import { LiveBackupsScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Create backup" };

export default function Page() {
  return <LiveBackupsScreen page="new" />;
}
