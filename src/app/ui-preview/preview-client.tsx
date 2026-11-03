"use client";

import { useState } from "react";
import { PreviewDropdown, PreviewToolbar } from "ui-preview-kit";
import {
  AccessScreen,
  ActivityScreen,
  BackupsScreen,
  DatabaseDetailScreen,
  DatabasesScreen,
  OverviewScreen,
} from "@/components/dashboard/screens";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ThemeControl } from "@/components/theme/theme-control";
import styles from "./page.module.css";

const screens = [
  { value: "overview", label: "Overview" },
  { value: "databases", label: "Databases" },
  { value: "database-detail", label: "Database detail" },
  { value: "access", label: "Access & roles" },
  { value: "backups", label: "Backups" },
  { value: "activity", label: "Activity" },
];

function previewPath(screen: string): string {
  if (screen === "databases" || screen === "database-detail") return "/databases";
  if (screen === "access") return "/access";
  if (screen === "backups") return "/backups";
  if (screen === "activity") return "/activity";
  return "/";
}

function PreviewScreen({ screen }: { screen: string }) {
  switch (screen) {
    case "databases":
      return <DatabasesScreen mode="preview" />;
    case "database-detail":
      return <DatabaseDetailScreen mode="preview" />;
    case "access":
      return <AccessScreen mode="preview" />;
    case "backups":
      return <BackupsScreen mode="preview" />;
    case "activity":
      return <ActivityScreen mode="preview" />;
    default:
      return <OverviewScreen mode="preview" />;
  }
}

export default function PreviewClient() {
  const [screen, setScreen] = useState("overview");

  return (
    <main className={styles.page}>
      <PreviewToolbar
        note="Synthetic data only. Actions are visual or disabled; nothing is sent to the VPS."
        subtitle="Nanogres screens · local preview · no sign-in required"
        theme="light"
        utilities={<ThemeControl />}
      >
        <PreviewDropdown label="Screen" value={screen} options={screens} onSelect={setScreen} />
      </PreviewToolbar>
      <DashboardShell
        account={{ name: "Avery Morgan", email: "avery@example.test" }}
        activePath={previewPath(screen)}
        previewMode
      >
        <PreviewScreen screen={screen} />
      </DashboardShell>
    </main>
  );
}
