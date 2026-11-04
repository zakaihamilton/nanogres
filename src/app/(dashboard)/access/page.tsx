import type { Metadata } from "next";
import { LiveAccessScreen } from "@/components/dashboard/live-screens";

export const metadata: Metadata = { title: "Access & roles · Nanogres" };

export default function AccessPage() {
  return <LiveAccessScreen page="list" />;
}
