// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Keyboard-focusable dashboard regions allow keyboard scrolling of wide tables.
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BackupTimelineChart } from "@/components/ui/svg-charts";
import {
  type BackupTransferCallbacks,
  buildBackupTimeline,
  downloadBackupFile,
  openBackupSaveWriter,
} from "@/lib/backup-transfer";
import { Icon } from "../icons";
import { type Backup, formatDate, type ServerStatus } from "../live-api";
import { Button, Empty, Loading, Notice, Panel } from "../live-primitives";
import styles from "../live-primitives.module.css";
import { formatBytes } from "../storage-capacity";

export function BackupsListView({
  rawBackups,
  backupsLoading,
  backupsError,
  overviewLoaded,
  overviewError,
  offsite,
  transferBusy,
  onBusyChange,
  onProgress,
  onError,
  onMessage,
}: BackupTransferCallbacks & {
  rawBackups: Backup[] | undefined;
  backupsLoading: boolean;
  backupsError: string | null;
  overviewLoaded: boolean;
  overviewError: string | null;
  offsite: ServerStatus["offsiteBackup"];
}) {
  const [filterDb, setFilterDb] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);

  const dailyTimeline = useMemo(() => buildBackupTimeline(rawBackups), [rawBackups]);

  const filteredBackups = useMemo(() => {
    if (!rawBackups) return [];
    if (!filterDb.trim()) return rawBackups;
    const query = filterDb.toLowerCase().trim();
    return rawBackups.filter((backup) => backup.database.toLowerCase().includes(query));
  }, [rawBackups, filterDb]);

  async function downloadExistingBackup(backup: Backup) {
    const { cancelled, writer } = await openBackupSaveWriter(backup.filename, onError);
    if (cancelled) return;

    setDownloading(backup.filename);
    onBusyChange(true);
    onError(null);
    onMessage(null);
    try {
      await downloadBackupFile(backup, writer, onProgress);
      onMessage(`Saved ${backup.filename} to your device.`);
    } catch (cause) {
      await writer?.abort?.().catch(() => {});
      onError(cause instanceof Error ? cause.message : "Could not download this backup.");
    } finally {
      setDownloading(null);
      onBusyChange(false);
      onProgress(null);
    }
  }

  return (
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
            {!overviewLoaded
              ? "Unknown"
              : offsite?.configured
                ? offsite.lastSuccessAt
                  ? "Local disk + S3 Storage"
                  : "S3 upload pending"
                : "Local VPS disk"}
          </strong>
        </div>
      </div>
      {!overviewLoaded ? (
        <Notice tone={overviewError ? "error" : "info"}>
          {overviewError
            ? "Off-site backup status is unavailable. Refresh to try again."
            : "Checking off-site backup status…"}
        </Notice>
      ) : offsite?.configured ? (
        <Notice tone={offsite.lastError ? "error" : "info"}>
          {offsite.lastError ? (
            "The latest off-site upload needs attention. The local backup snapshot remains available; check the off-site service log."
          ) : offsite.lastSuccessAt ? (
            <>
              {offsite.backupCount} retained backup{offsite.backupCount === 1 ? "" : "s"} stored in
              Spaces ({formatBytes(offsite.storedBytes)}). Last successful upload:{" "}
              {formatDate(offsite.lastSuccessAt)}. Future remote copies are not removed
              automatically when local retention expires.
            </>
          ) : (
            "Spaces is configured. The first off-site copy will run after the next backup cycle."
          )}
        </Notice>
      ) : (
        <Notice tone="info">
          Off-site storage is not configured yet. Local backup snapshots remain on the VPS for 14
          days.
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
            onChange={(event) => setFilterDb(event.target.value)}
            placeholder="Filter by database..."
            value={filterDb}
          />
        </div>
      </div>
      <Panel
        title="Backup history"
        detail={`${filteredBackups.length} retained file${filteredBackups.length === 1 ? "" : "s"}`}
      >
        {backupsLoading && !rawBackups ? (
          <Loading />
        ) : backupsError && !rawBackups ? (
          <Empty>Nanogres could not load backup history. Use Try again above to retry.</Empty>
        ) : filteredBackups.length ? (
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
  );
}
