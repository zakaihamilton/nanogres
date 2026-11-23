"use client";

import Link from "next/link";
import { useState } from "react";
import type { TransferProgress } from "@/lib/backup-transfer";
import { BackupCreateView } from "./backups/backup-create-view";
import { BackupRestoreView } from "./backups/backup-restore-view";
import { BackupsListView } from "./backups/backups-list-view";
import { type Backup, type ServerStatus, useApiData, useDatabases } from "./live-api";
import { ErrorNotice, Notice, PageHeader } from "./live-primitives";
import styles from "./live-primitives.module.css";
import { formatBytes } from "./storage-capacity";

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
  const userDatabases = databases.filter((item) => !item.systemDatabase);

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);

  async function refreshAll() {
    await Promise.all([backupsQuery.refresh(), refreshDatabases()]);
  }

  return (
    <div className={styles.screen}>
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
        action={
          page === "list" ? undefined : (
            <Link className={`${styles.button} ${styles.secondary}`} href="/backups">
              Back to backups
            </Link>
          )
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
        <BackupsListView
          backupsError={backupsQuery.error}
          backupsLoading={backupsQuery.loading}
          offsite={overviewQuery.data?.status.offsiteBackup}
          onBusyChange={setTransferBusy}
          onError={setError}
          onMessage={setMessage}
          onProgress={setTransferProgress}
          overviewError={overviewQuery.error}
          overviewLoaded={Boolean(overviewQuery.data)}
          rawBackups={rawBackups}
          transferBusy={transferBusy}
        />
      ) : page === "new" ? (
        <BackupCreateView
          databaseError={databaseError}
          databaseLoading={databaseLoading}
          onBusyChange={setTransferBusy}
          onCreated={() => backupsQuery.refresh()}
          onError={setError}
          onMessage={setMessage}
          onProgress={setTransferProgress}
          transferBusy={transferBusy}
          userDatabases={userDatabases}
        />
      ) : (
        <BackupRestoreView
          backupFilename={backupFilename}
          backups={rawBackups ?? []}
          backupsError={backupsQuery.error}
          backupsLoaded={Boolean(backupsQuery.data)}
          backupsLoading={backupsQuery.loading}
          message={message}
          mode={page}
          onBusyChange={setTransferBusy}
          onError={setError}
          onMessage={setMessage}
          onProgress={setTransferProgress}
          onRestored={refreshAll}
          transferBusy={transferBusy}
        />
      )}

      <Notice tone="info">
        Restores create a separate database and never overwrite an existing one. Keep downloaded
        copies in off-site storage for disaster recovery.
      </Notice>
    </div>
  );
}
