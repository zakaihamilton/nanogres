"use client";

import { useEffect, useRef, useState } from "react";
import { PreviewToolbar } from "ui-preview-kit";
import { DeleteDatabaseDialog } from "@/components/dashboard/live-screens";
import {
  AccessScreen,
  ActivityScreen,
  BackupsScreen,
  DatabasesScreen,
  GettingStartedScreen,
  OverviewScreen,
} from "@/components/dashboard/screens";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ThemeControl } from "@/components/theme/theme-control";
import { Select } from "@/components/ui/select";
import styles from "./page.module.css";

const screens = [
  { value: "overview", label: "Overview" },
  { value: "getting-started", label: "Getting started" },
  { value: "databases", label: "Databases" },
  { value: "database-new", label: "Create database" },
  { value: "delete-confirmation", label: "Delete confirmation" },
  { value: "access", label: "Access & roles" },
  { value: "access-new", label: "Create role" },
  { value: "backups", label: "Backups" },
  { value: "backups-new", label: "Create backup" },
  { value: "backups-restore", label: "Restore from file" },
  { value: "backups-restore-existing", label: "Restore retained backup" },
  { value: "activity", label: "Activity" },
];

function previewPath(screen: string, deleteDatabase: string): string {
  if (screen === "overview" || screen === "getting-started") return "/overview";
  if (screen === "database-new") return "/databases/new";
  if (screen === "delete-confirmation") return `/databases/${encodeURIComponent(deleteDatabase)}`;
  if (screen === "databases") return "/databases";
  if (screen === "access-new") return "/access/new";
  if (screen === "access") return "/access";
  if (screen === "backups-new") return "/backups/new";
  if (screen === "backups-restore") return "/backups/restore";
  if (screen === "backups-restore-existing") return "/backups/restore/preview.dump";
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
  previewBackup,
}: {
  screen: string;
  onNavigate: (screen: string) => void;
  onDelete: (database: string) => void;
  onCreateDatabase: (name: string) => void;
  onCreateRole: (name: string) => void;
  previewNotice: string | null;
  deleteDatabase: string;
  previewBackup: string;
}) {
  switch (screen) {
    case "getting-started":
      return <GettingStartedScreen />;
    case "database-new":
    case "databases":
      return (
        <DatabasesScreen
          mode="preview"
          previewPage={screen === "database-new" ? "new" : "list"}
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
    case "access-new":
    case "access":
      return (
        <AccessScreen
          mode="preview"
          previewPage={screen === "access-new" ? "new" : "list"}
          onPreviewNavigate={onNavigate}
          onPreviewCreateRole={onCreateRole}
          previewNotice={previewNotice}
        />
      );
    case "backups-new":
    case "backups-restore":
    case "backups-restore-existing":
    case "backups":
      return (
        <BackupsScreen
          mode="preview"
          previewBackup={previewBackup}
          onPreviewNavigate={onNavigate}
          previewPage={
            screen === "backups-new"
              ? "new"
              : screen === "backups-restore"
                ? "restore"
                : screen === "backups-restore-existing"
                  ? "restore-existing"
                  : "list"
          }
        />
      );
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
  const [previewBackup, setPreviewBackup] = useState("app_main");
  const restoreDeleteFocus = useRef(false);

  useEffect(() => {
    if (screen === "databases" && restoreDeleteFocus.current) {
      restoreDeleteFocus.current = false;
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Delete ${CSS.escape(deleteDatabase)}"]`,
        )
        ?.focus();
    }
  }, [screen, deleteDatabase]);

  function navigate(pathOrScreen: string) {
    if (screen === "delete-confirmation" && pathOrScreen === "databases")
      restoreDeleteFocus.current = true;
    if (pathOrScreen.startsWith("backups-restore-existing:")) {
      setPreviewBackup(pathOrScreen.split(":")[1] || "app_main");
      pathOrScreen = "backups-restore-existing";
    }
    const screenByPath: Record<string, string> = {
      "/": "overview",
      "/overview": "overview",
      "/databases": "databases",
      "/databases/new": "database-new",
      "/access": "access",
      "/access/new": "access-new",
      "/backups": "backups",
      "/backups/new": "backups-new",
      "/backups/restore": "backups-restore",
      "/backups/transfers": "backups",
      "/activity": "activity",
    };
    const mappedPath =
      screenByPath[pathOrScreen] ??
      (pathOrScreen.startsWith("/databases/")
        ? "databases"
        : pathOrScreen.startsWith("/backups/restore/")
          ? "backups-restore-existing"
          : undefined);
    const validScreen = screens.some((option) => option.value === pathOrScreen)
      ? pathOrScreen
      : "overview";
    setScreen(mappedPath ?? validScreen);
    setPreviewNotice(null);
  }

  function createDatabase(name: string) {
    setPreviewNotice(`Preview only. No database named “${name}” was created.`);
  }

  function createRole(name: string) {
    setPreviewNotice(`Preview only. No Postgres role named “${name}” was created.`);
  }

  return (
    <div className={styles.page}>
      <PreviewToolbar
        note="Synthetic data only. Some actions simulate a result; others are disabled. Nothing reaches the system."
        subtitle="Nanogres screens · local preview · no sign-in required"
        theme={toolbarTheme}
        utilities={<ThemeControl />}
      >
        <label className={styles.screenControl}>
          <span>Screen</span>
          <Select aria-label="Preview screen" onChange={navigate} value={screen}>
            {screens.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </PreviewToolbar>
      <DashboardShell
        account={{ name: "Avery Morgan", email: "avery@example.test" }}
        activePath={previewPath(screen, deleteDatabase)}
        currentOrganization={{ id: "org-main", name: "Acme Production Org" }}
        onPreviewNavigate={navigate}
        previewMode
        organizations={[
          {
            organizationId: "org-main",
            organizationName: "Acme Production Org",
            role: "manager",
          },
          {
            organizationId: "org-staging",
            organizationName: "Acme Staging Org",
            role: "viewer",
          },
        ]}
      >
        <PreviewScreen
          deleteDatabase={deleteDatabase}
          previewBackup={previewBackup}
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
    </div>
  );
}
