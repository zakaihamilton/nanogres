import type { Metadata } from "next";
import { DatabaseWorkspace } from "@/components/dashboard/database-workspace";

type PageProps = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { name } = await params;
  return {
    title: `${name} · Nanogres Database`,
  };
}

export default async function DatabasePage({ params }: PageProps) {
  const { name } = await params;
  return <DatabaseWorkspace databaseName={decodeURIComponent(name)} />;
}
