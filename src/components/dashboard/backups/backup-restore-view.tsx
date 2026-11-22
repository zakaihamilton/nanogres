"use client";

import { type FormEvent, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { type BackupTransferCallbacks, uploadBackupRestoreFile } from "@/lib/backup-transfer";
import { TENANT_NAME_MAX_LENGTH, TENANT_NAME_PATTERN } from "@/lib/tenant-names";
import { apiRequest, type Backup, formatDate } from "../live-api";
import { Button, Empty, Loading, Panel } from "../live-primitives";
import styles from "../live-primitives.module.css";
import { formatBytes } from "../storage-capacity";

export function BackupRestoreView({
  mode,
  backups,
  backupsLoading,
  backupsError,
  backupsLoaded,
  backupFilename,
  transferBusy,
  message,
  onBusyChange,
  onProgress,
  onError,
  onMessage,
  onRestored,
}: BackupTransferCallbacks & {
  mode: "restore" | "restore-existing";
  backups: Backup[];
  backupsLoading: boolean;
  backupsError: string | null;
  backupsLoaded: boolean;
  backupFilename?: string;
  message: string | null;
  onRestored: () => Promise<void>;
}) {
  const restoreBackup = backups.find((item) => item.filename === backupFilename);
  const [restoreNameInput, setRestoreName] = useState<string | null>(null);
  const restoreName =
    restoreNameInput ??
    (restoreBackup
      ? `${restoreBackup.database.slice(0, TENANT_NAME_MAX_LENGTH - "_restore".length)}_restore`
      : "");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    form: HTMLFormElement;
  } | null>(null);
  const confirmedRestore = useRef(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreFileName, setRestoreFileName] = useState("");

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
    onBusyChange(true);
    onError(null);
    onMessage(null);
    try {
      await apiRequest(`/api/nanogres/backups/${encodeURIComponent(backup.filename)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database: restoreName }),
      });
      onMessage(`Restored ${backup.filename} as ${restoreName}.`);
      setRestoreName("");
      await onRestored();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not restore this backup.");
    } finally {
      setRestoring(null);
      onBusyChange(false);
    }
  }

  async function restoreFromFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = restoreFile;
    if (!file || !file.size) {
      onError("Choose a non-empty PostgreSQL dump file.");
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
    onBusyChange(true);
    onError(null);
    onMessage(null);
    try {
      await uploadBackupRestoreFile(file, restoreFileName, onProgress);
      onMessage(`Restored ${file.name} as ${restoreFileName}.`);
      setRestoreFile(null);
      setRestoreFileName("");
      form.reset();
      await onRestored();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not restore this file.");
    } finally {
      setRestoring(null);
      onBusyChange(false);
      onProgress(null);
    }
  }

  return (
    <>
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

      {mode === "restore-existing" ? (
        <Panel title="Restore a backup" detail="Restore this recovery point into a new database.">
          {backupsLoading && !backupsLoaded ? (
            <Loading />
          ) : backupsError && !backupsLoaded ? (
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
      ) : (
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
                    setRestoreFileName(`${base || "restored_db"}_restore`);
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
      )}
    </>
  );
}
