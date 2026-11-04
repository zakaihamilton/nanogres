import type { Metadata } from "next";
import { LiveOverviewScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Overview · Nanogres" };

export default function OverviewPage() {
  return <LiveOverviewScreen />;
}
