import type { Metadata } from "next";
import { AccessScreen } from "@/components/dashboard/screens";

export const metadata: Metadata = { title: "Access & roles" };

export default function AccessPage() {
  return <AccessScreen mode="live" />;
}
