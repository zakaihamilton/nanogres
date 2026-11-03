import type { Metadata } from "next";
import { BackupsScreen } from "@/components/dashboard/screens";

export const metadata: Metadata = { title: "Backups" };

export default function BackupsPage() {
  return <BackupsScreen mode="live" />;
}
