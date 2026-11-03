import type { Metadata } from "next";
import { OverviewScreen } from "@/components/dashboard/screens";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return <OverviewScreen mode="live" />;
}
