import type { Metadata } from "next";
import { ActivityScreen } from "@/components/dashboard/screens";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return <ActivityScreen mode="live" />;
}
