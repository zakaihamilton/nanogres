import type { Metadata } from "next";
import { LiveDatabasesScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Databases · Nanogres" };

export default function DatabasesPage() {
  return <LiveDatabasesScreen page="list" />;
}
