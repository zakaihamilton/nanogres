"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import styles from "./live-screens.module.css";

type Database = {
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

type ServerStatus = {
  postgresVersion: string;
  startedAt: string;
  connections: number;
  maxConnections: number;
  disk: { totalBytes: number; usedBytes: number; freeBytes: number };
  backupRetentionDays: number;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
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
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2>{title}</h2>
          {detail ? <p>{detail}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function Notice({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" }) {
  return <div className={`${styles.notice} ${styles[tone]}`}>{children}</div>;
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
  onDelete,
  busyName,
}: {
  databases: Database[];
  onDelete?: (database: Database) => void;
  busyName?: string | null;
}) {
  if (!databases.length) return <Empty>No user databases yet. Create one to get started.</Empty>;
  return (
    <div className={styles.tableWrap}>
      <table>
        <thead>
          <tr>
            <th scope="col">Database</th>
            <th scope="col">Owner</th>
            <th scope="col">Size</th>
            <th scope="col">Connections</th>
            <th scope="col">Encoding</th>
            {onDelete ? (
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
              {onDelete ? (
                <td className={styles.actionCell}>
                  {database.systemDatabase ? (
                    <span className={styles.muted}>Protected</span>
                  ) : (
                    <Button
                      disabled={busyName === database.name}
                      onClick={() => onDelete(database)}
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

function ErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;
  const canBootstrap = error === "Perminister denied this action.";
  return (
    <>
      <Notice>{error}</Notice>
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
  const query = useApiData<{ databases: Database[] }>("/api/nanogres/databases");
  return { ...query, databases: query.data?.databases ?? [] };
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
        action={<PrimaryLink href="/databases">Manage databases</PrimaryLink>}
        description="Postgres inventory and server health for your private VPS."
        eyebrow="OVERVIEW"
        title="Postgres, at a glance."
      />
      <ErrorNotice error={error} />
      {loading && !data ? <Loading /> : null}
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
      <div className={styles.twoColumns}>
        <Panel
          title="Databases"
          detail={`${databases.length} total · ${formatBytes(totalSize)} used`}
        >
          {loading && !data ? <Loading /> : <DatabaseTable databases={databases.slice(0, 6)} />}
        </Panel>
        <Panel title="Server health" detail="CloudFanatic VPS · Chicago">
          {status ? (
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
                    {data?.backups[0] ? formatDate(data.backups[0].createdAt) : "No backups yet"}
                  </dd>
                </div>
              </dl>
            </div>
          ) : loading ? (
            <Loading />
          ) : (
            <Empty>Server health is unavailable.</Empty>
          )}
        </Panel>
      </div>
      <Panel title="Recent activity" detail="Nanogres operations on this VPS">
        <ActivityList events={data?.activity ?? []} loading={loading && !data} />
      </Panel>
      <Notice tone="info">
        Backups are stored on the same VPS disk. Download copies to keep an off-server recovery
        copy.
      </Notice>
    </div>
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
  const { databases, error, loading, refresh } = useDatabases();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
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

  async function deleteDatabase(database: Database) {
    if (
      !window.confirm(`Delete database “${database.name}”? This permanently removes all its data.`)
    )
      return;
    setBusyName(database.name);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest(`/api/nanogres/databases/${encodeURIComponent(database.name)}`, {
        method: "DELETE",
      });
      setMessage(`Database “${database.name}” deleted.`);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not delete database.");
    } finally {
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
      <ErrorNotice error={error} />
      <ErrorNotice error={actionError} />
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
        ) : (
          <DatabaseTable busyName={busyName} databases={databases} onDelete={deleteDatabase} />
        )}
      </Panel>
      <Notice tone="info">
        Postgres remains private on the VPS. Database access is granted through the Access &amp;
        roles page.
      </Notice>
    </div>
  );
}

export function LiveAccessScreen() {
  const { databases, error: databaseError, loading: databaseLoading } = useDatabases();
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
      <ErrorNotice error={databaseError ?? rolesQuery.error} />
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
        ) : roles.length ? (
          <div className={styles.tableWrap}>
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
  const { databases, refresh: refreshDatabases } = useDatabases();
  const backupsQuery = useApiData<{ backups: Backup[] }>("/api/nanogres/backups");
  const backups = backupsQuery.data?.backups ?? [];
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
        description="Daily backups plus on-demand snapshots, stored on the VPS."
        eyebrow="RECOVERY"
        title="Backups"
      />
      <ErrorNotice error={backupsQuery.error ?? error} />
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
          <strong>14 days</strong>
        </div>
        <div>
          <span>Destination</span>
          <strong>Private VPS disk</strong>
        </div>
      </div>
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
            {!selectedDatabase ? <option value="">No user databases</option> : null}
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
        ) : backups.length ? (
          <div className={styles.tableWrap}>
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
      <ErrorNotice error={error} />
      <Panel title="Recent events" detail="Newest operations first">
        <ActivityList events={data?.events ?? []} loading={loading && !data} />
      </Panel>
    </div>
  );
}

function ActivityList({ events, loading }: { events: ActivityEvent[]; loading: boolean }) {
  if (loading && !events.length) return <Loading />;
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
