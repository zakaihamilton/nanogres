"use client";

import { useEffect, useState } from "react";
import { PreviewToolbar } from "ui-preview-kit";
import { DeleteDatabaseDialog } from "@/components/dashboard/live-screens";
import {
  AccessScreen,
  ActivityScreen,
  BackupsScreen,
  DatabaseDetailScreen,
  DatabasesScreen,
  GettingStartedScreen,
  OverviewScreen,
} from "@/components/dashboard/screens";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ThemeControl } from "@/components/theme/theme-control";
import styles from "./page.module.css";

const screens = [
  { value: "overview", label: "Overview" },
  { value: "getting-started", label: "Getting started" },
  { value: "databases", label: "Databases" },
  { value: "delete-confirmation", label: "Delete confirmation" },
  { value: "database-detail", label: "Database detail" },
  { value: "access", label: "Access & roles" },
  { value: "backups", label: "Backups" },
  { value: "activity", label: "Activity" },
];

function previewPath(screen: string): string {
  if (screen === "databases" || screen === "database-detail" || screen === "delete-confirmation") {
    return "/databases";
  }
  if (screen === "access") return "/access";
  if (screen === "backups") return "/backups";
  if (screen === "activity") return "/activity";
  return "/";
}

function usePreviewToolbarTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const preference = document.documentElement.dataset.theme;
      setTheme(
        preference === "dark" || (preference !== "light" && media.matches) ? "dark" : "light",
      );
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    media.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  return theme;
}

function PreviewScreen({
  screen,
  onNavigate,
  onDelete,
  onCreateDatabase,
  onCreateRole,
  previewNotice,
  deleteDatabase,
}: {
  screen: string;
  onNavigate: (screen: string) => void;
  onDelete: (database: string) => void;
  onCreateDatabase: (name: string) => void;
  onCreateRole: (name: string) => void;
  previewNotice: string | null;
  deleteDatabase: string;
}) {
  switch (screen) {
    case "getting-started":
      return <GettingStartedScreen />;
    case "databases":
      return (
        <DatabasesScreen
          mode="preview"
          onPreviewNavigate={onNavigate}
          onPreviewDelete={(database) => onDelete(database.name)}
          onPreviewCreateDatabase={onCreateDatabase}
          previewNotice={previewNotice}
        />
      );
    case "delete-confirmation":
      return (
        <DeleteConfirmationPreview
          databaseName={deleteDatabase}
          onExit={() => onNavigate("databases")}
        />
      );
    case "database-detail":
      return <DatabaseDetailScreen mode="preview" onPreviewNavigate={onNavigate} />;
    case "access":
      return (
        <AccessScreen
          mode="preview"
          onPreviewCreateRole={onCreateRole}
          previewNotice={previewNotice}
        />
      );
    case "backups":
      return <BackupsScreen mode="preview" />;
    case "activity":
      return <ActivityScreen mode="preview" />;
    default:
      return (
        <OverviewScreen
          mode="preview"
          onPreviewNavigate={onNavigate}
          previewNotice={previewNotice}
        />
      );
  }
}

function DeleteConfirmationPreview({
  databaseName,
  onExit,
}: {
  databaseName: string;
  onExit: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const databaseFixtures = {
    app_main: {
      name: "app_main",
      owner: "app_service",
      sizeBytes: 1.8 * 1024 * 1024 * 1024,
      connections: 8,
      maxConnections: 100,
      encoding: "UTF8",
      systemDatabase: false,
    },
    event_store: {
      name: "event_store",
      owner: "worker_role",
      sizeBytes: 426 * 1024 * 1024,
      connections: 3,
      maxConnections: 50,
      encoding: "UTF8",
      systemDatabase: false,
    },
    sandbox: {
      name: "sandbox",
      owner: "dev_role",
      sizeBytes: 74 * 1024 * 1024,
      connections: 0,
      maxConnections: 20,
      encoding: "UTF8",
      systemDatabase: false,
    },
  };
  const previewDatabase =
    databaseFixtures[databaseName as keyof typeof databaseFixtures] ?? databaseFixtures.event_store;

  return open ? (
    <DeleteDatabaseDialog
      busy={false}
      database={previewDatabase}
      error={null}
      onCancel={() => {
        setOpen(false);
        onExit();
      }}
      onConfirm={() => {
        setConfirmed(true);
        setOpen(false);
      }}
    />
  ) : (
    <div className={styles.previewAction}>
      <p role="status">
        {confirmed
          ? "Preview only. No database was deleted."
          : "Dialog closed. No data was changed."}
      </p>
      <button
        onClick={() => {
          setConfirmed(false);
          setOpen(true);
        }}
        type="button"
      >
        Preview again
      </button>
    </div>
  );
}

export default function PreviewClient() {
  const toolbarTheme = usePreviewToolbarTheme();
  const [screen, setScreen] = useState("overview");
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  const [deleteDatabase, setDeleteDatabase] = useState("event_store");

  function navigate(pathOrScreen: string) {
    const screenByPath: Record<string, string> = {
      "/": "overview",
      "/databases": "databases",
      "/access": "access",
      "/backups": "backups",
      "/activity": "activity",
    };
    setScreen(screenByPath[pathOrScreen] ?? pathOrScreen);
    setPreviewNotice(null);
  }

  function createDatabase(name: string) {
    setPreviewNotice(`Preview only. No database named “${name}” was created.`);
  }

  function createRole(name: string) {
    setPreviewNotice(`Preview only. No Postgres role named “${name}” was created.`);
  }

  return (
    <main className={styles.page}>
      <PreviewToolbar
        note="Synthetic data only. Some actions simulate a result; others are disabled. Nothing reaches the VPS."
        subtitle="Nanogres screens · local preview · no sign-in required"
        theme={toolbarTheme}
        utilities={<ThemeControl />}
      >
        <label className={styles.screenControl}>
          <span>Screen</span>
          <select
            aria-label="Preview screen"
            onChange={(event) => navigate(event.target.value)}
            value={screen}
          >
            {screens.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </PreviewToolbar>
      <DashboardShell
        account={{ name: "Avery Morgan", email: "avery@example.test" }}
        activePath={previewPath(screen)}
        onPreviewNavigate={navigate}
        previewMode
      >
        <PreviewScreen
          deleteDatabase={deleteDatabase}
          onCreateDatabase={createDatabase}
          onCreateRole={createRole}
          onDelete={(name) => {
            setDeleteDatabase(name);
            setScreen("delete-confirmation");
          }}
          onNavigate={navigate}
          previewNotice={previewNotice}
          screen={screen}
        />
      </DashboardShell>
    </main>
  );
}
