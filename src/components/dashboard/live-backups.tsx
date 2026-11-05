"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatBytes } from "./storage-capacity";
import { BackupTimelineChart } from "@/components/ui/svg-charts";
import { Icon } from "./icons";
import {
  type Backup,
  type ServerStatus,
  apiRequest,
  useApiData,
  formatDate,
  PageHeader,
  Button,
  Panel,
  Notice,
  Loading,
  Empty,
  ErrorNotice,
  useDatabases,
} from "./live-shared";
import styles from "./live-screens.module.css";
import { TENANT_NAME_MAX_LENGTH, TENANT_NAME_PATTERN } from "@/lib/tenant-names";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard-focusable regions let users scroll wide data tables on small screens. */
const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const BACKUP_TIMELINE_DAYS = 14;

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

export function LiveBackupsScreen({
  page = "list",
  backupFilename,
}: {
  page?: "list" | "new" | "restore" | "restore-existing";
  backupFilename?: string;
}) {
  const {
    databases,
    error: databaseError,
    loading: databaseLoading,
    refresh: refreshDatabases,
  } = useDatabases();
  const backupsQuery = useApiData<{ backups: Backup[] }>("/api/nanogres/backups");
  const overviewQuery = useApiData<{ status: ServerStatus }>("/api/nanogres/overview");
  const rawBackups = backupsQuery.data?.backups;
  const backups = rawBackups ?? [];
  const offsite = overviewQuery.data?.status.offsiteBackup;
  const userDatabases = databases.filter((item) => !item.systemDatabase);
  const [filterDb, setFilterDb] = useState("");

  const dailyTimeline = useMemo(() => {
    if (!rawBackups) return [];
    const map = new Map<string, { sizeBytes: number; count: number }>();
    rawBackups.forEach((b) => {
      const createdAt = new Date(b.createdAt);
      if (Number.isNaN(createdAt.getTime())) return;
      const day = localDateKey(createdAt);
      const existing = map.get(day) || { sizeBytes: 0, count: 0 };
      map.set(day, { sizeBytes: existing.sizeBytes + b.sizeBytes, count: existing.count + 1 });
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstDay = new Date(today);
    firstDay.setDate(firstDay.getDate() - (BACKUP_TIMELINE_DAYS - 1));

    return Array.from({ length: BACKUP_TIMELINE_DAYS }, (_, index) => {
      const day = new Date(firstDay);
      day.setDate(firstDay.getDate() + index);
      const date = localDateKey(day);
      return { date, ...(map.get(date) ?? { sizeBytes: 0, count: 0 }) };
    });
  }, [rawBackups]);

  const filteredBackups = useMemo(() => {
    if (!rawBackups) return [];
    if (!filterDb.trim()) return rawBackups;
    return rawBackups.filter((b) =>
      b.database.toLowerCase().includes(filterDb.toLowerCase().trim()),
    );
  }, [rawBackups, filterDb]);
  const searchParams = useSearchParams();
  const [database, setDatabase] = useState(
    () => searchParams.get("db") || searchParams.get("database") || "",
  );
  const selectedDatabase = database || userDatabases[0]?.name || "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const restoreBackup = backups.find((item) => item.filename === backupFilename);
  const [restoreNameInput, setRestoreName] = useState<string | null>(null);
  const restoreName =
    restoreNameInput ??
    (restoreBackup
      ? restoreBackup.database.slice(0, TENANT_NAME_MAX_LENGTH - "_restore".length) + "_restore"
      : "");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    form: HTMLFormElement;
  } | null>(null);
  const confirmedRestore = useRef(false);
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

  async function restoreFromBackup(event: FormEvent<HTMLFormElement>, backup: Backup) {
    event.preventDefault();
    if (!confirmedRestore.current) {
      setConfirmation({
        message: `Restore ${backup.filename} as new database “${restoreName}”? Existing databases are never overwritten.`,
        form: event.currentTarget,
      });
      return;
    }
    confirmedRestore.current = false;

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
      setRestoreName("");
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
    if (!confirmedRestore.current) {
      setConfirmation({
        message: `Restore ${file.name} as new database “${restoreFileName}”? Existing databases are never overwritten. Only restore files you trust.`,
        form,
      });
      return;
    }
    confirmedRestore.current = false;

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
      if (/^[a-f0-9]{32}$/.test(upload.uploadId)) uploadId = upload.uploadId;
      if (
        !uploadId ||
        upload.chunkSizeBytes < 1 ||
        upload.chunkSizeBytes > TRANSFER_CHUNK_BYTES ||
        upload.chunkCount !== Math.ceil(file.size / upload.chunkSizeBytes)
      ) {
        throw new Error("The upload service returned invalid settings.");
      }

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
          // The system also removes abandoned uploads after 24 hours.
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
      {confirmation ? (
        <ConfirmDialog
          message={confirmation.message}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const form = confirmation.form;
            setConfirmation(null);
            confirmedRestore.current = true;
            form.requestSubmit();
          }}
        />
      ) : null}
      <PageHeader
        description="Daily recovery points, on-demand snapshots, and off-site copies."
        eyebrow="RECOVERY"
        title={
          page === "new"
            ? "Create a backup"
            : page === "restore"
              ? "Restore from a file"
              : page === "restore-existing"
                ? "Restore a backup"
                : "Backups"
        }
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
      {page === "list" ? (
        <>
          <div className={styles.formActions}>
            <Link className={styles.primaryButton} href="/backups/new">
              Create backup
            </Link>
            <Link className={`${styles.button} ${styles.secondary}`} href="/backups/restore">
              Restore from file
            </Link>
            <Link className={`${styles.button} ${styles.secondary}`} href="/backups/transfers">
              Import / export database
            </Link>
          </div>
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
                {!overviewQuery.data
                  ? "Unknown"
                  : offsite?.configured
                    ? offsite.lastSuccessAt
                      ? "Local disk + S3 Storage"
                      : "S3 upload pending"
                    : "Local workspace disk"}
              </strong>
            </div>
          </div>
          {!overviewQuery.data ? (
            <Notice tone={overviewQuery.error ? "error" : "info"}>
              {overviewQuery.error
                ? "Off-site backup status is unavailable. Refresh to try again."
                : "Checking off-site backup status…"}
            </Notice>
          ) : offsite?.configured ? (
            <Notice tone={offsite.lastError ? "error" : "info"}>
              {offsite.lastError
                ? "The latest off-site upload needs attention. The local backup snapshot remains available; check the off-site service log."
                : offsite.lastSuccessAt
                  ? `${offsite.backupCount} retained backup${offsite.backupCount === 1 ? "" : "s"} stored in Spaces (${formatBytes(offsite.storedBytes)}). Last successful upload: ${formatDate(offsite.lastSuccessAt)}. Remote copies are never removed automatically.`
                  : "Spaces is configured. The first off-site copy will run after the next backup cycle."}
            </Notice>
          ) : (
            <Notice tone="info">
              Off-site storage is not configured yet. Local backup snapshots remain in the workspace
              for 14 days.
            </Notice>
          )}
          {rawBackups ? (
            <Panel title="Backup retention timeline" detail="Daily backup size · last 14 days">
              <BackupTimelineChart backups={dailyTimeline} />
            </Panel>
          ) : null}
          <div className={styles.tableToolbar}>
            <div className={styles.searchInputWrap}>
              <Icon name="search" size={14} />
              <input
                aria-label="Filter backups by database"
                className={styles.searchInput}
                onChange={(e) => setFilterDb(e.target.value)}
                placeholder="Filter by database..."
                value={filterDb}
              />
            </div>
          </div>
          <Panel
            title="Backup history"
            detail={
              filteredBackups.length + " retained file" + (filteredBackups.length === 1 ? "" : "s")
            }
          >
            {backupsQuery.loading && !backupsQuery.data ? (
              <Loading />
            ) : backupsQuery.error && !backupsQuery.data ? (
              <Empty>Nanogres could not load backup history. Use Try again above to retry.</Empty>
            ) : filteredBackups.length ? (
              <div
                aria-label="Backup history"
                className={styles.tableWrap}
                role="region"
                tabIndex={0}
              >
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
                    {filteredBackups.map((backup) => (
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
                            <Link
                              className={styles.button}
                              href={`/backups/restore/${encodeURIComponent(backup.filename)}`}
                              aria-label={`Restore as new: ${backup.filename}`}
                            >
                              Restore as new
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {filterDb.trim()
                  ? `No backups match database “${filterDb}”.`
                  : "No backup files yet. The daily timer runs near 02:00 UTC."}
              </Empty>
            )}
          </Panel>
        </>
      ) : page === "new" ? (
        <>
          <Panel
            title="Create a backup now"
            detail="Create a compressed PostgreSQL dump and save a copy to your device."
          >
            <div className={styles.inlineForm}>
              <label className={styles.srOnly} htmlFor="backup-database">
                Database
              </label>
              <Select
                id="backup-database"
                disabled={!userDatabases.length || transferBusy}
                onChange={setDatabase}
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
              </Select>
              <Button
                disabled={transferBusy || !selectedDatabase}
                onClick={() => void createBackupAndDownload()}
              >
                {saving ? "Creating and downloading…" : "Create & download .dump"}
              </Button>
            </div>
          </Panel>
        </>
      ) : page === "restore-existing" ? (
        <>
          <Panel title="Restore a backup" detail="Restore this recovery point into a new database.">
            {backupsQuery.loading && !backupsQuery.data ? (
              <Loading />
            ) : backupsQuery.error && !backupsQuery.data ? (
              <Empty>Could not load backup history. Use Try again above to retry.</Empty>
            ) : !restoreBackup ? (
              <Empty>
                This backup is no longer available. Return to backup history to choose another.
              </Empty>
            ) : (
              <form
                className={styles.formGrid}
                onSubmit={(event) => void restoreFromBackup(event, restoreBackup)}
              >
                <p className={styles.restoreBackupSummary}>
                  Backup: <strong>{restoreBackup.filename}</strong> ·{" "}
                  {formatBytes(restoreBackup.sizeBytes)} · {formatDate(restoreBackup.createdAt)}
                </p>
                <div className={styles.field}>
                  <label htmlFor="restore-existing-name">New database name</label>
                  <input
                    autoComplete="off"
                    id="restore-existing-name"
                    maxLength={TENANT_NAME_MAX_LENGTH}
                    minLength={1}
                    pattern={TENANT_NAME_PATTERN}
                    required
                    value={restoreName}
                    onChange={(event) => setRestoreName(event.target.value)}
                  />
                  <small>
                    Restores into a separate database. Existing databases are never replaced. Max{" "}
                    {TENANT_NAME_MAX_LENGTH} characters.
                  </small>
                </div>
                <div className={styles.formActions}>
                  <Button disabled={transferBusy || Boolean(message)} type="submit">
                    {restoring === restoreBackup.filename ? "Restoring…" : "Restore"}
                  </Button>
                </div>
              </form>
            )}
          </Panel>
        </>
      ) : (
        <>
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
                        .slice(0, TENANT_NAME_MAX_LENGTH - "_restore".length);
                      setRestoreFileName((base || "restored_db") + "_restore");
                    }
                  }}
                  required
                  type="file"
                />
                <small>
                  Supports compressed custom-format .dump and .backup files. The upload is sent in
                  small encrypted chunks and removed from the system after restore.
                </small>
              </div>
              <div className={styles.field}>
                <label htmlFor="restore-file-database">New database name</label>
                <input
                  autoComplete="off"
                  id="restore-file-database"
                  maxLength={TENANT_NAME_MAX_LENGTH}
                  minLength={1}
                  onChange={(event) => setRestoreFileName(event.target.value)}
                  pattern={TENANT_NAME_PATTERN}
                  placeholder="restored_project"
                  required
                  value={restoreFileName}
                />
                <small>
                  Existing databases are never overwritten. Max {TENANT_NAME_MAX_LENGTH} characters.
                </small>
              </div>
              <div className={styles.formActions}>
                <Button disabled={transferBusy || restoreFile === null} type="submit">
                  {restoring === "uploaded-file" ? "Uploading and restoring…" : "Restore from file"}
                </Button>
              </div>
            </form>
          </Panel>
        </>
      )}
      <Notice tone="info">
        Restores create a separate database and never overwrite an existing one. Keep downloaded
        copies in off-site storage for disaster recovery.
      </Notice>
    </div>
  );
}
