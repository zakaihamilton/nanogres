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
  previewDatabaseNamesForScenario,
} from "@/components/dashboard/screens";
import type { PreviewScenario } from "@/components/dashboard/screens";
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
const scenarioOptions: { value: PreviewScenario; label: string }[] = [
  { value: "healthy", label: "Healthy server" },
  { value: "disconnected-server", label: "Disconnected server" },
  { value: "empty-cluster", label: "Empty cluster" },
  { value: "many-databases", label: "Many databases" },
  { value: "long-names", label: "Long database and organization names" },
  { value: "near-full-storage", label: "Near-full storage" },
  { value: "storage-full", label: "Storage almost full" },
  { value: "connection-saturation", label: "Connection limit near" },
  { value: "backups-stale", label: "Stale backups" },
  { value: "backups-failed", label: "Failed backup" },
  { value: "backups-unconfigured", label: "Backups not configured" },
  { value: "read-only", label: "Read-only member" },
  { value: "validation-errors", label: "Form validation errors" },
  { value: "delete-error", label: "Delete error dialog" },
];

function screenForScenario(scenario: PreviewScenario): string | undefined {
  if (
    scenario === "many-databases" ||
    scenario === "long-names" ||
    scenario === "empty-cluster"
  )
    return "databases";
  if (scenario.startsWith("backups-")) return "backups";
  if (scenario === "validation-errors") return "database-new";
  if (scenario === "delete-error") return "delete-confirmation";
  if (scenario === "disconnected-server" || scenario === "connection-saturation") return "overview";
  return undefined;
}

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
  previewScenario,
  deleteDatabase,
  previewBackup,
}: {
  screen: string;
  onNavigate: (screen: string) => void;
  onDelete: (database: string) => void;
  onCreateDatabase: (name: string) => void;
  onCreateRole: (name: string) => void;
  previewNotice: string | null;
  previewScenario: PreviewScenario;
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
          previewScenario={previewScenario}
          readOnly={previewScenario === "read-only"}
          validationPreview={previewScenario === "validation-errors"}
        />
      );
    case "delete-confirmation":
      return (
        <DeleteConfirmationPreview
          databaseName={deleteDatabase}
          error={previewScenario === "delete-error" ? "The database could not be deleted. Try again." : null}
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
          previewScenario={previewScenario}
          readOnly={previewScenario === "read-only"}
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
          previewScenario={previewScenario}
          readOnly={previewScenario === "read-only"}
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
          previewScenario={previewScenario}
          readOnly={previewScenario === "read-only"}
        />
      );
  }
}

function DeleteConfirmationPreview({
  databaseName,
  error,
  onExit,
}: {
  databaseName: string;
  error: string | null;
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
      error={error}
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
  const [previewScenario, setPreviewScenario] = useState<PreviewScenario>("healthy");
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

  function selectScenario(value: string) {
    const nextScenario = value as PreviewScenario;
    setPreviewScenario(nextScenario);
    const suggestedScreen = screenForScenario(nextScenario);
    if (suggestedScreen) setScreen(suggestedScreen);
    setPreviewNotice(null);
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
        <label className={styles.screenControl}>
          <span>Scenario</span>
          <Select aria-label="Preview scenario" onChange={selectScenario} value={previewScenario}>
            {scenarioOptions.map((option) => (
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
        previewDatabaseNames={previewDatabaseNamesForScenario(previewScenario)}
        currentOrganization={{
          id: "org-main",
          name:
            previewScenario === "long-names"
              ? "Acme Production Organization for Regional Analytics Teams"
              : "Acme Production Org",
        }}
        onPreviewNavigate={navigate}
        previewMode
        organizations={[
          {
            organizationId: "org-main",
            organizationName:
              previewScenario === "long-names"
                ? "Acme Production Organization for Regional Analytics Teams"
                : "Acme Production Org",
            role: previewScenario === "read-only" ? "viewer" : "manager",
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
          previewScenario={previewScenario}
          screen={screen}
        />
      </DashboardShell>
    </div>
  );
}
