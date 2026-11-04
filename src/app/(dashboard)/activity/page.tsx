import type { Metadata } from "next";
import { LiveActivityScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Activity · Nanogres" };

export default function ActivityPage() {
  return <LiveActivityScreen />;
}
