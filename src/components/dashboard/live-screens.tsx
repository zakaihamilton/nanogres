"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import { PanelFrame } from "./panel-frame";
import {
  formatBytes,
  StorageCapacity,
  type DatabaseStorage,
  type StorageDisk,
} from "./storage-capacity";
import styles from "./live-screens.module.css";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard-focusable regions let users scroll wide data tables on small screens. */

type Database = DatabaseStorage & {
  name: string;
  owner: string;
  sizeBytes: number;
  connections: number;
  maxConnections: number;
  encoding: string;
  systemDatabase: boolean;
};

type Backup = {
  filename: string;
  database: string;
  createdAt: string;
  sizeBytes: number;
};

type Role = {
  name: string;
  superuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  validUntil: string | null;
  systemRole: boolean;
};

type ActivityEvent = {
  action: string;
  detail: string;
  actor: string | null;
  createdAt: string;
};

type OffsiteBackupStatus = {
  configured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  backupCount: number;
  storedBytes: number;
  lastError: string | null;
};

type ServerStatus = {
  postgresVersion: string;
  startedAt: string;
  connections: number;
  maxConnections: number;
  disk: StorageDisk;
  backupRetentionDays: number;
  databaseGrowthPercent?: number;
  databaseQuotaEnforced?: boolean;
  databaseQuotaReason?: string | null;
  databaseQuotaCheckedAt?: string | null;
  offsiteBackup?: OffsiteBackupStatus;
};

type ApiPayload = object;

const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_DOWNLOAD_BYTES = 128 * 1024 * 1024;

type TransferFileWriter = {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable: () => Promise<TransferFileWriter> }>;
};

type TransferProgress = {
  label: string;
  transferred: number;
  total: number;
};

async function apiRequest<T extends ApiPayload>(path: string, init?: RequestInit): Promise<T> {
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
    throw new Error("The VPS API returned an invalid response.");
  return payload as T;
}

function useApiData<T extends ApiPayload>(path: string) {
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isFilePickerCancelled(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError"
  );
}

async function chooseDownloadWriter(filename: string): Promise<TransferFileWriter | null> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  const handle = await picker({
    suggestedName: filename,
    types: [
      {
        description: "PostgreSQL custom-format dump",
        accept: { "application/octet-stream": [".dump"] },
      },
    ],
  });
  return handle.createWritable();
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).error === "string"
    ) {
      return new Error(String((payload as Record<string, unknown>).error));
    }
  } catch {
    // Fall through to the status-based message.
  }
  return new Error("Transfer failed (" + response.status + ").");
}

function triggerBufferedDownload(chunks: Uint8Array[], filename: string): void {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function PageHeader({
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

function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className={styles.primaryButton} href={href}>
      {children}
    </Link>
  );
}

function Button({
  children,
  disabled = false,
  onClick,
  variant = "primary",
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
}) {
  return (
    <button
      className={`${styles.button} ${styles[variant]}`}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

function Panel({
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

function Notice({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" }) {
  return (
    <div
      className={`${styles.notice} ${styles[tone]}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

function Loading({ label = "Loading server data…" }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      {label}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

function DatabaseTable({
  databases,
  onRequestDelete,
  busyName,
}: {
  databases: Database[];
  onRequestDelete?: (database: Database) => void;
  busyName?: string | null;
}) {
  if (!databases.length) return <Empty>No user databases yet. Create one to get started.</Empty>;
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
            {onRequestDelete ? (
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {databases.map((database) => (
            <tr key={database.name}>
              <td>
                <span className={styles.databaseName}>{database.name}</span>
                {database.systemDatabase ? (
                  <small className={styles.systemTag}>default</small>
                ) : null}
              </td>
              <td>{database.owner}</td>
              <td>{formatBytes(database.sizeBytes)}</td>
              <td>
                {database.connections} / {database.maxConnections}
              </td>
              <td>{database.encoding}</td>
              {onRequestDelete ? (
                <td className={styles.actionCell}>
                  {database.systemDatabase ? (
                    <span className={styles.muted}>Protected</span>
                  ) : (
                    <Button
                      disabled={busyName === database.name}
                      onClick={() => onRequestDelete(database)}
                      variant="danger"
                    >
                      {busyName === database.name ? "Deleting…" : "Delete"}
                    </Button>
                  )}
                </td>
              ) : null}
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
            maxLength={63}
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

function ErrorNotice({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
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

function WorkspaceBootstrap() {
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

function useDatabases() {
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

export function LiveOverviewScreen() {
  const { data, error, loading, refresh } = useApiData<{
    status: ServerStatus;
    databases: Database[];
    backups: Backup[];
    activity: ActivityEvent[];
  }>("/api/nanogres/overview");
  const status = data?.status;
  const databases = data?.databases ?? [];
  const totalSize = databases.reduce((sum, database) => sum + database.sizeBytes, 0);
  return (
    <div className={styles.screen}>
      <PageHeader
        action={<PrimaryLink href="/databases">Create a database</PrimaryLink>}
        description="A clear view of database health, storage, access, and recovery."
        eyebrow="YOUR WORKSPACE"
        title="Your Postgres, in one place."
      />
      {loading && !data ? <Loading label="Connecting to your VPS…" /> : null}
      {!loading && !data ? <FirstRunCard error={error} /> : null}
      {data && error ? <ErrorNotice error={error} onRetry={() => void refresh()} /> : null}
      {data && !status && !error ? (
        <ErrorNotice error="Server health is unavailable." onRetry={() => void refresh()} />
      ) : null}
      {status ? (
        <div className={styles.metrics}>
          <Metric
            label="Databases"
            value={String(databases.filter((item) => !item.systemDatabase).length)}
            detail="User databases"
          />
          <Metric
            label="Connections"
            value={String(status.connections)}
            detail={`Maximum ${status.maxConnections}`}
          />
          <Metric
            label="Database storage"
            value={formatBytes(totalSize)}
            detail="Across visible databases"
          />
          <Metric
            label="Free disk"
            value={formatBytes(status.disk.freeBytes)}
            detail={`of ${formatBytes(status.disk.totalBytes)}`}
          />
        </div>
      ) : null}
      {data && status ? (
        <>
          <div className={styles.twoColumns}>
            <Panel
              title="Databases"
              detail={`${databases.length} total · ${formatBytes(totalSize)} used`}
            >
              <DatabaseTable databases={databases.slice(0, 6)} />
            </Panel>
            <Panel title="Server health" detail="PostgreSQL on your private VPS">
              <div className={styles.health}>
                <span className={styles.healthyDot} />
                <div>
                  <strong>PostgreSQL is responding</strong>
                  <small>Version {status.postgresVersion}</small>
                </div>
                <Button onClick={() => void refresh()} variant="secondary">
                  Refresh
                </Button>
                <dl>
                  <div>
                    <dt>Started</dt>
                    <dd>{formatDate(status.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>Backup retention</dt>
                    <dd>{status.backupRetentionDays} days on this VPS</dd>
                  </div>
                  <div>
                    <dt>Latest backup</dt>
                    <dd>
                      {data.backups[0] ? formatDate(data.backups[0].createdAt) : "No backups yet"}
                    </dd>
                  </div>
                  <div>
                    <dt>Off-site copy</dt>
                    <dd>
                      {!status.offsiteBackup?.configured
                        ? "Not configured"
                        : status.offsiteBackup.lastSuccessAt
                          ? `Verified ${formatDate(status.offsiteBackup.lastSuccessAt)}`
                          : "Waiting for first upload"}
                    </dd>
                  </div>
                </dl>
              </div>
            </Panel>
          </div>
          <Panel
            title="Storage capacity"
            detail="Disk usage and current growth room for each user database"
          >
            <StorageCapacity
              databases={databases}
              disk={status.disk}
              enforcementReason={status.databaseQuotaReason}
              growthPercent={status.databaseGrowthPercent ?? 25}
            />
          </Panel>
          <Panel title="Recent activity" detail="Database and access changes on this VPS">
            <ActivityList error={null} events={data.activity} loading={false} />
          </Panel>
          <Notice tone="info">
            {status.offsiteBackup?.lastSuccessAt
              ? `Off-site backups are verified in DigitalOcean Spaces. The latest successful copy is ${formatDate(status.offsiteBackup.lastSuccessAt)}.`
              : "Backups are stored on the VPS until off-site storage is configured and the first upload is verified."}
          </Notice>
        </>
      ) : null}
    </div>
  );
}

export function FirstRunCard({ error }: { error: string | null }) {
  const needsWorkspaceAccess = error === "Perminister denied this action.";

  return (
    <section aria-labelledby="first-run-title" className={styles.firstRunCard}>
      <div className={styles.firstRunIntro}>
        <div className={styles.firstRunLabel}>
          <span className={styles.firstRunIcon}>
            <Icon name="server" size={18} />
          </span>
          <span>GETTING STARTED</span>
        </div>
        <h2 id="first-run-title">
          {needsWorkspaceAccess
            ? "Grant your account access to this workspace."
            : "Connect your VPS to see your Postgres workspace."}
        </h2>
        <p>
          {needsWorkspaceAccess
            ? "Your VPS is connected. Perminister needs to grant this account workspace access before Nanogres can show database health, storage, backups, and recent changes."
            : "Once the private management API is connected, this page will show database health, storage, backups, and recent changes."}
        </p>
        {needsWorkspaceAccess ? (
          <WorkspaceBootstrap />
        ) : (
          <a
            className={styles.setupLink}
            href="https://github.com/zakaihamilton/nanogres#connect-your-vps"
            rel="noreferrer"
            target="_blank"
          >
            Open the setup guide <span aria-hidden="true">↗</span>
          </a>
        )}
        {error && !needsWorkspaceAccess ? (
          <details className={styles.connectionDetails}>
            <summary>Connection details</summary>
            <p>{error}</p>
          </details>
        ) : null}
      </div>
      <ol aria-label="Your first three steps" className={styles.firstRunSteps}>
        <li className={styles.firstRunStep}>
          <span className={styles.stepNumber}>01</span>
          <span>
            <strong>
              {needsWorkspaceAccess ? "Grant workspace access" : "Connect your server"}
            </strong>
            <small>
              {needsWorkspaceAccess
                ? "Initialize this workspace in Perminister."
                : "Set up the private HTTPS API."}
            </small>
          </span>
          <Icon name={needsWorkspaceAccess ? "shield" : "server"} size={16} />
        </li>
        <li className={styles.firstRunStep}>
          <span className={styles.stepNumber}>02</span>
          <span>
            <strong>Create a database</strong>
            <small>Give each project its own space.</small>
          </span>
          <Icon name="database" size={16} />
        </li>
        <li className={styles.firstRunStep}>
          <span className={styles.stepNumber}>03</span>
          <span>
            <strong>Save a backup copy</strong>
            <small>Download a dump for off-server recovery.</small>
          </span>
          <Icon name="backup" size={16} />
        </li>
      </ol>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

export function LiveDatabasesScreen() {
  const { databases, error, loading, refresh, status } = useDatabases();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const deletingDatabase = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<Database | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function createDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest("/api/nanogres/databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setName("");
      setMessage(`Database “${name}” created.`);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not create database.");
    } finally {
      setSaving(false);
    }
  }

  function requestDatabaseDeletion(database: Database) {
    setActionError(null);
    setDeleteTarget(database);
  }

  function cancelDatabaseDeletion() {
    if (busyName) return;
    setDeleteTarget(null);
    setActionError(null);
  }

  async function confirmDatabaseDeletion(database: Database) {
    if (deletingDatabase.current) return;
    deletingDatabase.current = true;
    setBusyName(database.name);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest(`/api/nanogres/databases/${encodeURIComponent(database.name)}`, {
        method: "DELETE",
      });
      setMessage(`Database “${database.name}” deleted.`);
      setDeleteTarget(null);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not delete database.");
    } finally {
      deletingDatabase.current = false;
      setBusyName(null);
    }
  }

  return (
    <div className={styles.screen}>
      <PageHeader
        description="Create databases and review size, owners, and active connections."
        eyebrow="DATA"
        title="Databases"
      />
      <ErrorNotice error={error} onRetry={() => void refresh()} />
      <ErrorNotice error={deleteTarget ? null : actionError} />
      {message ? <Notice tone="info">{message}</Notice> : null}
      <Panel
        title="Create a database"
        detail="Names use lowercase letters, numbers, and underscores."
      >
        <form className={styles.form} onSubmit={createDatabase}>
          <label htmlFor="database-name">Database name</label>
          <div className={styles.formRow}>
            <input
              autoComplete="off"
              id="database-name"
              maxLength={63}
              minLength={2}
              onChange={(event) => setName(event.target.value)}
              pattern="[a-z][a-z0-9_]{1,62}"
              placeholder="my_project"
              required
              value={name}
            />
            <Button disabled={saving} type="submit">
              {saving ? "Creating…" : "Create database"}
            </Button>
          </div>
        </form>
      </Panel>
      {status ? (
        <Panel title="Storage capacity" detail="Current disk space and per-database growth room">
          <StorageCapacity
            databases={databases}
            disk={status.disk}
            growthPercent={status.databaseGrowthPercent ?? 25}
          />
        </Panel>
      ) : null}
      <Panel
        title="All databases"
        detail={
          loading
            ? "Refreshing inventory…"
            : `${databases.length} database${databases.length === 1 ? "" : "s"}`
        }
      >
        {loading && !databases.length ? (
          <Loading />
        ) : error && !databases.length ? (
          <Empty>Nanogres could not load the database list. Use Try again above to retry.</Empty>
        ) : (
          <DatabaseTable
            busyName={busyName}
            databases={databases}
            onRequestDelete={requestDatabaseDeletion}
          />
        )}
      </Panel>
      <Notice tone="info">
        Postgres remains private on the VPS. Database access is granted through the Access &amp;
        roles page.
      </Notice>
      {deleteTarget ? (
        <DeleteDatabaseDialog
          busy={busyName === deleteTarget.name}
          database={deleteTarget}
          error={actionError}
          onCancel={cancelDatabaseDeletion}
          onConfirm={() => void confirmDatabaseDeletion(deleteTarget)}
        />
      ) : null}
    </div>
  );
}

export function LiveAccessScreen() {
  const {
    databases,
    error: databaseError,
    loading: databaseLoading,
    refresh: refreshDatabases,
  } = useDatabases();
  const userDatabases = databases.filter((item) => !item.systemDatabase);
  const rolesQuery = useApiData<{ roles: Role[] }>("/api/nanogres/roles");
  const roles = rolesQuery.data?.roles ?? [];
  const [name, setName] = useState("");
  const [database, setDatabase] = useState("");
  const selectedDatabase = database || userDatabases[0]?.name || "";
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<"readwrite" | "readonly">("readwrite");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest("/api/nanogres/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, database: selectedDatabase, password, access }),
      });
      setName("");
      setPassword("");
      setMessage(
        `Role “${name}” created for ${selectedDatabase}. Store the password safely; Nanogres will not show it again.`,
      );
      await rolesQuery.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not create role.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.screen}>
      <PageHeader
        description="Create least-privilege Postgres login roles for individual databases."
        eyebrow="SECURITY"
        title="Access & roles"
      />
      <ErrorNotice
        error={databaseError ?? rolesQuery.error}
        onRetry={() => {
          if (databaseError) void refreshDatabases();
          if (rolesQuery.error) void rolesQuery.refresh();
        }}
      />
      <ErrorNotice error={actionError} />
      {message ? <Notice tone="info">{message}</Notice> : null}
      <Notice tone="info">
        People and their Nanogres permissions are managed in Perminister. These are database login
        roles for your applications.
      </Notice>
      <Panel
        title="Create a database role"
        detail="Passwords are sent over HTTPS, stored by Postgres as SCRAM hashes, and never displayed again."
      >
        {databaseLoading ? (
          <Loading />
        ) : databaseError && !userDatabases.length ? (
          <Empty>Nanogres could not load databases. Use Try again above to retry.</Empty>
        ) : userDatabases.length ? (
          <form className={styles.formGrid} onSubmit={createRole}>
            <div className={styles.field}>
              <label htmlFor="role-name">Role name</label>
              <input
                id="role-name"
                maxLength={63}
                minLength={2}
                onChange={(event) => setName(event.target.value)}
                pattern="[a-z][a-z0-9_]{1,62}"
                placeholder="my_app_user"
                required
                value={name}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="role-database">Database</label>
              <select
                id="role-database"
                onChange={(event) => setDatabase(event.target.value)}
                required
                value={selectedDatabase}
              >
                {userDatabases.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="role-access">Access level</label>
              <select
                id="role-access"
                onChange={(event) => setAccess(event.target.value as "readwrite" | "readonly")}
                value={access}
              >
                <option value="readwrite">Read and write</option>
                <option value="readonly">Read only</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="role-password">Initial password</label>
              <input
                autoComplete="new-password"
                id="role-password"
                minLength={16}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
              <small>
                Use at least 16 characters. Generate and store it in your password manager.
              </small>
            </div>
            <div className={styles.formActions}>
              <Button disabled={saving} type="submit">
                {saving ? "Creating…" : "Create role"}
              </Button>
            </div>
          </form>
        ) : (
          <Empty>Create a database before adding a login role.</Empty>
        )}
      </Panel>
      <Panel
        title="Login roles"
        detail={`${roles.length} Postgres login role${roles.length === 1 ? "" : "s"}`}
      >
        {rolesQuery.loading && !rolesQuery.data ? (
          <Loading />
        ) : rolesQuery.error && !rolesQuery.data ? (
          <Empty>Nanogres could not load database roles. Use Try again above to retry.</Empty>
        ) : roles.length ? (
          <div aria-label="Login roles" className={styles.tableWrap} role="region" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Privileges</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.name}>
                    <td>
                      <span className={styles.databaseName}>{role.name}</span>
                      {role.systemRole ? <small className={styles.systemTag}>system</small> : null}
                    </td>
                    <td>
                      {role.superuser
                        ? "Superuser"
                        : [
                            role.canCreateDatabase ? "Create database" : "",
                            role.canCreateRole ? "Create roles" : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Database grants"}
                    </td>
                    <td>{role.validUntil ? formatDate(role.validUntil) : "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No login roles found.</Empty>
        )}
      </Panel>
    </div>
  );
}

export function LiveBackupsScreen() {
  const {
    databases,
    error: databaseError,
    loading: databaseLoading,
    refresh: refreshDatabases,
  } = useDatabases();
  const backupsQuery = useApiData<{ backups: Backup[] }>("/api/nanogres/backups");
  const overviewQuery = useApiData<{ status: ServerStatus }>("/api/nanogres/overview");
  const backups = backupsQuery.data?.backups ?? [];
  const offsite = overviewQuery.data?.status.offsiteBackup;
  const userDatabases = databases.filter((item) => !item.systemDatabase);
  const [database, setDatabase] = useState("");
  const selectedDatabase = database || userDatabases[0]?.name || "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restoreBackup, setRestoreBackup] = useState<Backup | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreFileName, setRestoreFileName] = useState("");
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);

  async function downloadBackupFile(backup: Backup, writer: TransferFileWriter | null) {
    if (!backup.sizeBytes) throw new Error("The backup file is empty.");
    if (!writer && backup.sizeBytes > MAX_BUFFERED_DOWNLOAD_BYTES) {
      throw new Error(
        "This browser cannot save files larger than 128 MB directly. Use Chrome or Edge for large backups.",
      );
    }

    const bufferedChunks: Uint8Array[] = [];
    let transferred = 0;
    try {
      while (transferred < backup.sizeBytes) {
        const length = Math.min(TRANSFER_CHUNK_BYTES, backup.sizeBytes - transferred);
        const query = new URLSearchParams({
          offset: String(transferred),
          length: String(length),
        });
        const response = await fetch(
          "/api/nanogres/backups/" + encodeURIComponent(backup.filename) + "?" + query.toString(),
          { cache: "no-store" },
        );
        if (!response.ok) throw await responseError(response);
        const chunk = new Uint8Array(await response.arrayBuffer());
        if (chunk.byteLength !== length) {
          throw new Error("The backup download ended before the complete file was received.");
        }
        if (writer) await writer.write(chunk);
        else bufferedChunks.push(chunk);
        transferred += chunk.byteLength;
        setTransferProgress({
          label: "Saving " + backup.filename,
          transferred,
          total: backup.sizeBytes,
        });
      }

      if (writer) await writer.close();
      else triggerBufferedDownload(bufferedChunks, backup.filename);
    } catch (cause) {
      await writer?.abort?.().catch(() => {});
      throw cause;
    } finally {
      setTransferProgress(null);
    }
  }

  async function createBackupAndDownload() {
    if (!selectedDatabase) return;
    const suggestedName = selectedDatabase + "-" + new Date().toISOString().slice(0, 10) + ".dump";
    let writer: TransferFileWriter | null;
    try {
      writer = await chooseDownloadWriter(suggestedName);
    } catch (cause) {
      if (!isFilePickerCancelled(cause)) {
        setError(cause instanceof Error ? cause.message : "Could not open the save dialog.");
      }
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiRequest<{ backup: Backup }>("/api/nanogres/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database: selectedDatabase }),
      });
      await backupsQuery.refresh();
      await downloadBackupFile(result.backup, writer);
      setMessage("Created and downloaded " + result.backup.filename + ".");
    } catch (cause) {
      await writer?.abort?.().catch(() => {});
      setError(cause instanceof Error ? cause.message : "Could not create backup.");
      await backupsQuery.refresh();
    } finally {
      setSaving(false);
      setTransferProgress(null);
    }
  }

  async function downloadExistingBackup(backup: Backup) {
    let writer: TransferFileWriter | null;
    try {
      writer = await chooseDownloadWriter(backup.filename);
    } catch (cause) {
      if (!isFilePickerCancelled(cause)) {
        setError(cause instanceof Error ? cause.message : "Could not open the save dialog.");
      }
      return;
    }

    setDownloading(backup.filename);
    setError(null);
    setMessage(null);
    try {
      await downloadBackupFile(backup, writer);
      setMessage("Saved " + backup.filename + " to your device.");
    } catch (cause) {
      await writer?.abort?.().catch(() => {});
      setError(cause instanceof Error ? cause.message : "Could not download this backup.");
    } finally {
      setDownloading(null);
      setTransferProgress(null);
    }
  }

  function startRestore(backup: Backup) {
    setRestoreBackup(backup);
    setRestoreName(backup.database.slice(0, 54) + "_restore");
    setError(null);
    setMessage(null);
  }

  async function restoreFromBackup(event: FormEvent<HTMLFormElement>, backup: Backup) {
    event.preventDefault();
    if (
      !window.confirm(
        "Restore " +
          backup.filename +
          " as new database “" +
          restoreName +
          "”? Existing databases are never overwritten.",
      )
    ) {
      return;
    }

    setRestoring(backup.filename);
    setError(null);
    setMessage(null);
    try {
      await apiRequest(
        "/api/nanogres/backups/" + encodeURIComponent(backup.filename) + "/restore",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ database: restoreName }),
        },
      );
      setMessage("Restored " + backup.filename + " as " + restoreName + ".");
      setRestoreBackup(null);
      await Promise.all([backupsQuery.refresh(), refreshDatabases()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this backup.");
    } finally {
      setRestoring(null);
    }
  }

  async function restoreFromFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = restoreFile;
    if (!file || !file.size) {
      setError("Choose a non-empty PostgreSQL dump file.");
      return;
    }
    if (
      !window.confirm(
        "Restore " +
          file.name +
          " as new database “" +
          restoreFileName +
          "”? Existing databases are never overwritten. Only restore files you trust.",
      )
    ) {
      return;
    }

    setRestoring("uploaded-file");
    setError(null);
    setMessage(null);
    let uploadId: string | null = null;
    try {
      const upload = await apiRequest<{
        uploadId: string;
        chunkSizeBytes: number;
        chunkCount: number;
      }>("/api/nanogres/restore-uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sizeBytes: file.size }),
      });
      if (
        !/^[a-f0-9]{32}$/.test(upload.uploadId) ||
        upload.chunkSizeBytes < 1 ||
        upload.chunkSizeBytes > TRANSFER_CHUNK_BYTES ||
        upload.chunkCount !== Math.ceil(file.size / upload.chunkSizeBytes)
      ) {
        throw new Error("The VPS returned invalid upload settings.");
      }
      uploadId = upload.uploadId;

      for (let offset = 0, index = 0; offset < file.size; index += 1) {
        const end = Math.min(offset + upload.chunkSizeBytes, file.size);
        const chunk = file.slice(offset, end);
        const response = await fetch(
          "/api/nanogres/restore-uploads/" + uploadId + "/chunks/" + index,
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: chunk,
            cache: "no-store",
          },
        );
        if (!response.ok) throw await responseError(response);
        offset = end;
        setTransferProgress({
          label: "Uploading " + file.name,
          transferred: offset,
          total: file.size,
        });
      }

      setTransferProgress({
        label: "Restoring into " + restoreFileName,
        transferred: file.size,
        total: file.size,
      });
      await apiRequest("/api/nanogres/restore-uploads/" + uploadId + "/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database: restoreFileName }),
      });
      uploadId = null;
      setMessage("Restored " + file.name + " as " + restoreFileName + ".");
      setRestoreFile(null);
      setRestoreFileName("");
      form.reset();
      await Promise.all([backupsQuery.refresh(), refreshDatabases()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this file.");
      if (uploadId) {
        try {
          await apiRequest("/api/nanogres/restore-uploads/" + uploadId, { method: "DELETE" });
        } catch {
          // The VPS also removes abandoned uploads after 24 hours.
        }
      }
    } finally {
      setRestoring(null);
      setTransferProgress(null);
    }
  }

  const transferBusy = saving || downloading !== null || restoring !== null;

  return (
    <div className={styles.screen}>
      <PageHeader
        description="Daily recovery points, on-demand snapshots, and off-site copies."
        eyebrow="RECOVERY"
        title="Backups"
      />
      <ErrorNotice error={databaseError} onRetry={() => void refreshDatabases()} />
      <ErrorNotice error={backupsQuery.error} onRetry={() => void backupsQuery.refresh()} />
      <ErrorNotice error={error} />
      {message ? <Notice tone="info">{message}</Notice> : null}
      {transferProgress ? (
        <Notice tone="info">
          {transferProgress.label}: {formatBytes(transferProgress.transferred)} /{" "}
          {formatBytes(transferProgress.total)}
        </Notice>
      ) : null}
      <div className={styles.backupSummary}>
        <div>
          <span>Schedule</span>
          <strong>Daily near 02:00 UTC</strong>
        </div>
        <div>
          <span>Retention</span>
          <strong>14 days locally</strong>
        </div>
        <div>
          <span>Destination</span>
          <strong>
            {offsite?.configured
              ? offsite.lastSuccessAt
                ? "VPS + DigitalOcean Spaces"
                : "Spaces upload pending"
              : "Private VPS disk"}
          </strong>
        </div>
      </div>
      {offsite?.configured ? (
        <Notice tone={offsite.lastError ? "error" : "info"}>
          {offsite.lastError
            ? "The latest off-site upload needs attention. The VPS backup remains available; check the off-site service log."
            : offsite.lastSuccessAt
              ? `${offsite.backupCount} retained backup${offsite.backupCount === 1 ? "" : "s"} verified in Spaces (${formatBytes(offsite.storedBytes)}). Last successful upload: ${formatDate(offsite.lastSuccessAt)}. Remote copies are never removed automatically.`
              : "Spaces is configured. The first off-site copy will run after the next backup cycle."}
        </Notice>
      ) : (
        <Notice tone="info">
          Off-site storage is not configured yet. Local backups remain on the VPS for 14 days.
        </Notice>
      )}
      <Panel
        title="Create a backup now"
        detail="Create a compressed PostgreSQL dump and save a copy to your device."
      >
        <div className={styles.inlineForm}>
          <label className={styles.srOnly} htmlFor="backup-database">
            Database
          </label>
          <select
            id="backup-database"
            disabled={!userDatabases.length || transferBusy}
            onChange={(event) => setDatabase(event.target.value)}
            value={selectedDatabase}
          >
            {!selectedDatabase ? (
              <option value="">
                {databaseLoading
                  ? "Loading databases…"
                  : databaseError
                    ? "Could not load databases"
                    : "No user databases"}
              </option>
            ) : null}
            {userDatabases.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          <Button
            disabled={transferBusy || !selectedDatabase}
            onClick={() => void createBackupAndDownload()}
          >
            {saving ? "Creating and downloading…" : "Create & download .dump"}
          </Button>
        </div>
      </Panel>
      <Panel
        title="Backup history"
        detail={backups.length + " retained file" + (backups.length === 1 ? "" : "s")}
      >
        {backupsQuery.loading && !backupsQuery.data ? (
          <Loading />
        ) : backupsQuery.error && !backupsQuery.data ? (
          <Empty>Nanogres could not load backup history. Use Try again above to retry.</Empty>
        ) : backups.length ? (
          <div aria-label="Backup history" className={styles.tableWrap} role="region" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Database</th>
                  <th scope="col">Created</th>
                  <th scope="col">Size</th>
                  <th scope="col">
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.filename}>
                    <td>
                      <span className={styles.databaseName}>{backup.database}</span>
                    </td>
                    <td>{formatDate(backup.createdAt)}</td>
                    <td>{formatBytes(backup.sizeBytes)}</td>
                    <td className={styles.actionCell}>
                      <div className={styles.backupActions}>
                        <Button
                          disabled={transferBusy}
                          onClick={() => void downloadExistingBackup(backup)}
                          variant="secondary"
                        >
                          {downloading === backup.filename ? "Downloading…" : "Download file"}
                        </Button>
                        <Button
                          disabled={transferBusy}
                          onClick={() => startRestore(backup)}
                          variant="secondary"
                        >
                          Restore as new
                        </Button>
                      </div>
                      {restoreBackup?.filename === backup.filename ? (
                        <form
                          className={styles.restoreForm}
                          onSubmit={(event) => void restoreFromBackup(event, backup)}
                        >
                          <label htmlFor={"restore-name-" + backup.filename}>
                            New database name
                          </label>
                          <input
                            autoComplete="off"
                            id={"restore-name-" + backup.filename}
                            maxLength={63}
                            minLength={1}
                            onChange={(event) => setRestoreName(event.target.value)}
                            pattern="[a-z][a-z0-9_]{0,62}"
                            required
                            value={restoreName}
                          />
                          <small>
                            Restores into a separate database. Existing databases are never
                            replaced.
                          </small>
                          <div className={styles.restoreActions}>
                            <Button
                              disabled={transferBusy}
                              onClick={() => setRestoreBackup(null)}
                              variant="secondary"
                            >
                              Cancel
                            </Button>
                            <Button disabled={transferBusy} type="submit">
                              {restoring === backup.filename ? "Restoring…" : "Restore"}
                            </Button>
                          </div>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No backup files yet. The daily timer runs near 02:00 UTC.</Empty>
        )}
      </Panel>
      <Panel
        title="Restore from a file"
        detail="Import a trusted custom-format PostgreSQL dump into a new database."
      >
        <form className={styles.formGrid} onSubmit={(event) => void restoreFromFile(event)}>
          <div className={styles.field}>
            <label htmlFor="restore-file">PostgreSQL dump file</label>
            <input
              accept=".dump,.backup,application/octet-stream"
              id="restore-file"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setRestoreFile(file);
                if (file && !restoreFileName) {
                  const base = file.name
                    .replace(/\.(dump|backup)$/i, "")
                    .toLowerCase()
                    .replace(/[^a-z0-9_]/g, "_")
                    .replace(/^[^a-z]+/, "")
                    .slice(0, 54);
                  setRestoreFileName((base || "restored_db") + "_restore");
                }
              }}
              required
              type="file"
            />
            <small>
              Supports compressed custom-format .dump and .backup files. The upload is sent in small
              encrypted chunks and removed from the VPS after restore.
            </small>
          </div>
          <div className={styles.field}>
            <label htmlFor="restore-file-database">New database name</label>
            <input
              autoComplete="off"
              id="restore-file-database"
              maxLength={63}
              minLength={1}
              onChange={(event) => setRestoreFileName(event.target.value)}
              pattern="[a-z][a-z0-9_]{0,62}"
              placeholder="restored_project"
              required
              value={restoreFileName}
            />
            <small>Existing databases are never overwritten.</small>
          </div>
          <div className={styles.formActions}>
            <Button disabled={transferBusy || restoreFile === null} type="submit">
              {restoring === "uploaded-file" ? "Uploading and restoring…" : "Restore from file"}
            </Button>
          </div>
        </form>
      </Panel>
      <Notice tone="info">
        Restores create a separate database and never overwrite an existing one. Keep downloaded
        copies somewhere separate from this VPS for off-server recovery.
      </Notice>
    </div>
  );
}
export function LiveActivityScreen() {
  const { data, error, loading, refresh } = useApiData<{ events: ActivityEvent[] }>(
    "/api/nanogres/activity",
  );
  return (
    <div className={styles.screen}>
      <PageHeader
        action={
          <Button onClick={() => void refresh()} variant="secondary">
            Refresh
          </Button>
        }
        description="A server-side record of database, role, and backup operations."
        eyebrow="AUDIT TRAIL"
        title="Activity"
      />
      <ErrorNotice error={error} onRetry={() => void refresh()} />
      <Panel title="Recent events" detail="Newest operations first">
        <ActivityList error={error} events={data?.events ?? []} loading={loading && !data} />
      </Panel>
    </div>
  );
}

function ActivityList({
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
