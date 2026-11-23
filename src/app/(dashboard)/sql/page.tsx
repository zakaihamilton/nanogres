import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading } from "@/components/dashboard/live-shared";
import { SqlEditorScreen } from "@/components/dashboard/sql-editor-screen";

export const metadata: Metadata = { title: "SQL Editor · Nanogres" };

export default function SqlPage() {
  return (
    <Suspense fallback={<Loading label="Loading SQL Studio..." />}>
      <SqlEditorScreen />
    </Suspense>
  );
}
