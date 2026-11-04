import type { Metadata } from "next";
import { LiveAccessScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Create role" };

export default function Page() {
  return <LiveAccessScreen page="new" />;
}
