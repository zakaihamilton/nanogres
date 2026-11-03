import type { Metadata } from "next";
import { DatabasesScreen } from "@/components/dashboard/screens";

export const metadata: Metadata = { title: "Databases" };

export default function DatabasesPage() {
  return <DatabasesScreen mode="live" />;
}
