import type { Metadata } from "next";
import { LiveDatabasesScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Create database" };

export default function Page() {
  return <LiveDatabasesScreen page="new" />;
}
