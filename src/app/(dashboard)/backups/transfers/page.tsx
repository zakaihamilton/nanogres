import type { Metadata } from "next";
import { LiveTransfersScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Database transfers · Nanogres" };

export default function TransfersPage() {
  return <LiveTransfersScreen />;
}
