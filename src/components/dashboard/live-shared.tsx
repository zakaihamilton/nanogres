"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { PanelFrame } from "./panel-frame";
import { formatBytes, type DatabaseStorage, type StorageDisk } from "./storage-capacity";
import styles from "./live-screens.module.css";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard-focusable regions let users scroll wide data tables on small screens. */
export type Database = DatabaseStorage & {
  name: string;
  owner: string;
  sizeBytes: number;
  connections: number;
  maxConnections: number;
  encoding: string;
  systemDatabase: boolean;
};

export type Backup = {
  filename: string;
  database: string;
  createdAt: string;
  sizeBytes: number;
};

export type Role = {
  name: string;
  loginName: string;
  database: string | null;
  connectionDatabase: string | null;
  databases: string[];
  superuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  validUntil: string | null;
  systemRole: boolean;
};

export type ActivityEvent = {
  action: string;
  detail: string;
  actor: string | null;
  createdAt: string;
};

type OffsiteBackupStatus = {
  configured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessAgeSeconds?: number | null;
  backupCount: number;
  storedBytes: number;
  lastError: string | null;
  freshness?: "not-configured" | "pending" | "fresh" | "stale" | "error";
};

export type ServerStatus = {
  postgresVersion: string;
  startedAt: string;
  connections: number;
  maxConnections: number;
  disk: StorageDisk;
  backupRetentionDays: number;
  databaseGrowthPercent?: number;
  databaseQuotaReserveBytes?: number;
  databaseQuotaEnforced?: boolean;
  databaseQuotaReason?: string | null;
  databaseQuotaCheckedAt?: string | null;
  offsiteBackup?: OffsiteBackupStatus;
};

type ApiPayload = object;

export async function apiRequest<T extends ApiPayload>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).error === "string"
        ? String((payload as Record<string, unknown>).error)
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (typeof payload !== "object" || payload === null)
    throw new Error("The workspace service returned an invalid response.");
  return payload as T;
}

export function useApiData<T extends ApiPayload>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiRequest<T>(path);
      setData(payload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load server data.");
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const payload = await apiRequest<T>(path);
        if (active) {
          setData(payload);
          setError(null);
        }
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load server data.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [path]);
  return { data, error, loading, refresh };
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.pageHeader}>
      <div>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p className={styles.description}>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className={styles.primaryButton} href={href}>
      {children}
    </Link>
  );
}

export function Button({
  children,
  disabled = false,
  onClick,
  ariaLabel,
  variant = "primary",
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={`${styles.button} ${styles[variant]}`}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <PanelFrame
      className={styles.panel}
      headingClassName={styles.panelHeader}
      title={title}
      detail={detail}
    >
      {children}
    </PanelFrame>
  );
}

export function Notice({
  children,
  tone = "error",
}: {
  children: ReactNode;
  tone?: "error" | "info" | "warning";
}) {
  return (
    <div
      className={`${styles.notice} ${styles[tone]}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function Loading({ label = "Loading server data…" }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function DatabaseTable({
  databases,
  onRequestDelete,
  onConnect,
  busyName,
  emptyMessage,
}: {
  databases: Database[];
  onRequestDelete?: (database: Database) => void;
  onConnect?: (databaseName: string) => void;
  busyName?: string | null;
  emptyMessage?: ReactNode;
}) {
  if (!databases.length) {
    return <Empty>{emptyMessage || "No user databases yet. Create one to get started."}</Empty>;
  }
  return (
    <div aria-label="Databases" className={styles.tableWrap} role="region" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">Database</th>
            <th scope="col">Owner</th>
            <th scope="col">Size</th>
            <th scope="col">Connections</th>
            <th scope="col">Encoding</th>
            <th scope="col">
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {databases.map((database) => (
            <tr key={database.name}>
              <td>
                <Link
                  className={styles.databaseName}
                  href={`/databases/${encodeURIComponent(database.name)}`}
                  title="Open database workspace"
                >
                  {database.name}
                </Link>
                {database.systemDatabase ? (
                  <small className={styles.systemTag}>system</small>
                ) : null}
              </td>
              <td>{database.owner}</td>
              <td>{formatBytes(database.sizeBytes)}</td>
              <td>
                {database.connections} / {database.maxConnections}
              </td>
              <td>{database.encoding}</td>
              <td className={styles.actionCell}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {onConnect ? (
                    <button
                      className={styles.rowAction}
                      onClick={() => onConnect(database.name)}
                      type="button"
                    >
                      Connect
                    </button>
                  ) : null}
                  <Link
                    className={styles.rowAction}
                    href={`/databases/${encodeURIComponent(database.name)}`}
                  >
                    Manage
                  </Link>
                  {onRequestDelete ? (
                    database.systemDatabase ? (
                      <span className={styles.muted}>Protected</span>
                    ) : (
                      <Button
                        ariaLabel={`Delete ${database.name}`}
                        disabled={busyName === database.name}
                        onClick={() => onRequestDelete(database)}
                        variant="danger"
                      >
                        {busyName === database.name ? "Deleting…" : "Delete"}
                      </Button>
                    )
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DeleteDatabaseDialog({
  database,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  database: Database;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    nameInputRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  async function copyDatabaseName() {
    try {
      await navigator.clipboard.writeText(database.name);
      setCopyStatus("Database name copied.");
    } catch {
      setCopyStatus("Could not copy. Select the name and copy it manually.");
    }
  }

  function confirmDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || confirmationName !== database.name) return;
    onConfirm();
  }

  return (
    <dialog
      aria-describedby="delete-database-warning"
      aria-busy={busy}
      aria-labelledby="delete-database-title"
      aria-modal="true"
      className={styles.dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      ref={dialogRef}
      role="alertdialog"
    >
      <div className={styles.dialogContent}>
        <p className={styles.dialogEyebrow}>DESTRUCTIVE ACTION</p>
        <h2 id="delete-database-title">Delete database?</h2>
        <p className={styles.dialogWarning} id="delete-database-warning">
          This permanently deletes the database and all of its data. This cannot be undone.
        </p>
        <div className={styles.dialogNameGroup}>
          <span className={styles.dialogNameLabel}>Database name</span>
          <div className={styles.dialogNameRow}>
            <code className={styles.dialogDatabaseName}>{database.name}</code>
            <Button disabled={busy} onClick={() => void copyDatabaseName()} variant="secondary">
              Copy name
            </Button>
          </div>
          <span aria-live="polite" className={styles.dialogStatus} role="status">
            {copyStatus}
          </span>
        </div>
        <form className={styles.dialogForm} onSubmit={confirmDeletion}>
          <label htmlFor="delete-database-confirmation">
            Type the database name exactly to enable deletion.
          </label>
          <input
            autoCapitalize="off"
            autoComplete="off"
            disabled={busy}
            id="delete-database-confirmation"
            maxLength={37}
            onChange={(event) => setConfirmationName(event.target.value)}
            placeholder="Type the database name"
            ref={nameInputRef}
            required
            spellCheck={false}
            value={confirmationName}
          />
          {error ? (
            <p className={styles.dialogError} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.dialogActions}>
            <Button disabled={busy} onClick={onCancel} variant="secondary">
              Cancel
            </Button>
            <Button
              disabled={busy || confirmationName !== database.name}
              type="submit"
              variant="danger"
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

export function ErrorNotice({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  const canBootstrap = error === "Perminister denied this action.";
  return (
    <>
      <Notice>
        <span>{error}</span>
        {onRetry && !canBootstrap ? (
          <Button onClick={onRetry} variant="secondary">
            Try again
          </Button>
        ) : null}
      </Notice>
      {canBootstrap ? <WorkspaceBootstrap /> : null}
    </>
  );
}

export function WorkspaceBootstrap() {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  async function initialize() {
    setState("saving");
    setMessage(null);
    try {
      const response = await fetch("/api/setup/workspace", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not initialize workspace.",
        );
      window.location.reload();
    } catch (cause) {
      setState("error");
      setMessage(cause instanceof Error ? cause.message : "Could not initialize workspace.");
    }
  }
  return (
    <div className={styles.bootstrap}>
      <p>
        Your current account can initialize its Nanogres workspace. Perminister will grant the
        signed-in account workspace admin access.
      </p>
      <Button disabled={state === "saving"} onClick={() => void initialize()}>
        {state === "saving" ? "Initializing…" : "Initialize workspace access"}
      </Button>
      {message ? <small role="alert">{message}</small> : null}
    </div>
  );
}

export function useDatabases() {
  const query = useApiData<{ databases: Database[]; status?: ServerStatus }>(
    "/api/nanogres/databases",
  );
  const [fallbackStatus, setFallbackStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    if (!query.data || query.data.status || fallbackStatus) return;
    let active = true;
    void apiRequest<{ status?: ServerStatus }>("/api/nanogres/overview")
      .then((payload) => {
        if (active) setFallbackStatus(payload.status ?? null);
      })
      .catch(() => {
        if (active) setFallbackStatus(null);
      });
    return () => {
      active = false;
    };
  }, [fallbackStatus, query.data]);

  return {
    ...query,
    databases: query.data?.databases ?? [],
    status: query.data?.status ?? fallbackStatus,
  };
}

export function ActivityList({
  events,
  loading,
  error,
}: {
  events: ActivityEvent[];
  loading: boolean;
  error: string | null;
}) {
  if (loading && !events.length) return <Loading />;
  if (error && !events.length) {
    return <Empty>Nanogres could not load activity. Use Try again above to retry.</Empty>;
  }
  if (!events.length) return <Empty>No Nanogres operations recorded yet.</Empty>;
  return (
    <div className={styles.activityList}>
      {events.map((event, index) => (
        <div className={styles.activityItem} key={`${event.createdAt}-${index}`}>
          <span className={styles.activityMark} aria-hidden="true" />
          <div>
            <strong>{event.action.replaceAll(".", " ")}</strong>
            <p>
              {event.detail}
              {event.actor ? ` · actor ${event.actor}` : ""}
            </p>
          </div>
          <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
        </div>
      ))}
    </div>
  );
}
