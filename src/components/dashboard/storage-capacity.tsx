"use client";

import { Select } from "@/components/ui/select";

import { useState, type FormEvent } from "react";
import styles from "./storage-capacity.module.css";

export type StorageDisk = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
};

export type DatabaseQuotaChange = { mode: "auto" } | { mode: "custom"; maxBytes: number };

export type DatabaseStorage = {
  name: string;
  connectionName?: string;
  sizeBytes: number;
  growthHeadroomBytes?: number;
  recommendedMaxBytes?: number;
  quotaUsedBytes?: number;
  hardLimitEnforced?: boolean;
  systemDatabase: boolean;
  quotaMode?: "auto" | "custom";
  requestedMaxBytes?: number | null;
  maximumCustomMaxBytes?: number;
  quotaConstrained?: boolean;
};

const GIB = 1024 ** 3;

export function formatBytes(bytes: number): string {
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

function percentage(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

function getDatabaseQuotaUsageBytes(database: DatabaseStorage): number {
  return database.hardLimitEnforced
    ? (database.quotaUsedBytes ?? database.sizeBytes)
    : database.sizeBytes;
}

function quotaInputValue(bytes: number): string {
  return String(bytes / GIB);
}

export function StorageCapacity({
  disk,
  databases,
  growthPercent,
  reserveBytes = GIB,
  enforcementReason,
  onSaveQuota,
  savingQuotaName,
}: {
  disk: StorageDisk;
  databases: DatabaseStorage[];
  growthPercent: number;
  reserveBytes?: number;
  enforcementReason?: string | null;
  onSaveQuota?: (database: string, quota: DatabaseQuotaChange) => Promise<void>;
  savingQuotaName?: string | null;
}) {
  const [editingName, setEditingName] = useState<string | null>(null);
  const [quotaMode, setQuotaMode] = useState<"auto" | "custom">("auto");
  const [quotaSizeGiB, setQuotaSizeGiB] = useState("");
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const diskUsedPercent = percentage(disk.usedBytes, disk.totalBytes);
  const userDatabases = databases.filter((database) => !database.systemDatabase);
  const safeGrowthPercent = Math.min(50, Math.max(1, growthPercent));
  const totalDatabaseUsageBytes = databases.reduce(
    (total, database) => total + database.sizeBytes,
    0,
  );
  const perDatabaseHeadroom = userDatabases.length
    ? Math.floor(
        (Math.max(0, disk.freeBytes - reserveBytes) * safeGrowthPercent) /
          100 /
          userDatabases.length,
      )
    : 0;
  const quotaEnforced =
    userDatabases.length > 0 &&
    userDatabases.every((database) => database.hardLimitEnforced === true);

  function startEditing(database: DatabaseStorage) {
    const currentMaximum =
      database.requestedMaxBytes ??
      database.recommendedMaxBytes ??
      getDatabaseQuotaUsageBytes(database) + perDatabaseHeadroom;
    const maximumAvailable = database.maximumCustomMaxBytes;
    setEditingName(database.name);
    setQuotaMode(database.quotaMode ?? "auto");
    setQuotaSizeGiB(
      quotaInputValue(
        maximumAvailable === undefined
          ? currentMaximum
          : Math.min(currentMaximum, maximumAvailable),
      ),
    );
    setQuotaError(null);
  }

  async function submitQuota(event: FormEvent<HTMLFormElement>, database: DatabaseStorage) {
    event.preventDefault();
    if (!onSaveQuota) return;

    let request: DatabaseQuotaChange = { mode: "auto" };
    if (quotaMode === "custom") {
      const gib = Number(quotaSizeGiB);
      const requestedBytes = Math.round(gib * GIB);
      const currentUsage = getDatabaseQuotaUsageBytes(database);
      const minimumMaxBytes = Math.max(currentUsage, database.sizeBytes);
      const maximumBytes = database.maximumCustomMaxBytes ?? database.recommendedMaxBytes ?? 0;
      if (!Number.isFinite(gib) || requestedBytes < minimumMaxBytes) {
        setQuotaError(
          `Choose a maximum at least as large as current database size (${formatBytes(minimumMaxBytes)}).`,
        );
        return;
      }
      if (requestedBytes > maximumBytes) {
        setQuotaError(
          `The current maximum available for this database is ${formatBytes(maximumBytes)}.`,
        );
        return;
      }
      request = { mode: "custom", maxBytes: requestedBytes };
    }

    setQuotaError(null);
    try {
      await onSaveQuota(database.name, request);
      setEditingName(null);
    } catch (cause) {
      setQuotaError(
        cause instanceof Error ? cause.message : "Could not update the database size limit.",
      );
    }
  }

  return (
    <div className={styles.capacity}>
      <div className={styles.diskSummary}>
        <div className={styles.summaryHeading}>
          <div>
            <strong>VPS storage volume</strong>
            <span>
              {formatBytes(disk.usedBytes)} used of {formatBytes(disk.totalBytes)}
            </span>
          </div>
          <div className={styles.freeSpace}>
            <strong>{formatBytes(disk.freeBytes)}</strong>
            <span>free on disk</span>
          </div>
        </div>
        <div
          aria-label={`VPS disk ${formatBytes(disk.usedBytes)} used of ${formatBytes(disk.totalBytes)}`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(diskUsedPercent)}
          className={styles.track}
          role="progressbar"
        >
          <span className={styles.diskFill} style={{ width: `${diskUsedPercent}%` }} />
        </div>
        <div className={styles.databaseTotal}>
          <span>Your organization&apos;s databases</span>
          <strong>{formatBytes(totalDatabaseUsageBytes)} database files on disk</strong>
        </div>
      </div>

      <div className={styles.policyHeader}>
        <div>
          <strong>Per-database growth room</strong>
          <span>
            {safeGrowthPercent}% of free disk after the {formatBytes(reserveBytes)} system reserve
            is available to database growth. Custom limits use this shared budget; Auto databases
            share what remains.
          </span>
        </div>
        <span
          className={`${styles.policyPill} ${quotaEnforced ? styles.enforced : styles.advisory}`}
        >
          {quotaEnforced ? "Quota enforced" : "Advisory target"}
        </span>
      </div>

      {userDatabases.length ? (
        <ul aria-label="Database storage usage and growth room" className={styles.databaseList}>
          {userDatabases.map((database) => {
            const quotaUsage = getDatabaseQuotaUsageBytes(database);
            const recommendedMaxBytes =
              database.recommendedMaxBytes ?? quotaUsage + perDatabaseHeadroom;
            const growthHeadroomBytes = Math.max(0, recommendedMaxBytes - quotaUsage);
            const fill = percentage(quotaUsage, recommendedMaxBytes);
            const maximumCustomMaxBytes = database.maximumCustomMaxBytes ?? recommendedMaxBytes;
            const isEditing = editingName === database.name;
            const isSaving = savingQuotaName === database.name;
            return (
              <li className={styles.databaseItem} key={database.name}>
                <div className={styles.databaseHeading}>
                  <code>{database.name}</code>
                  <div className={styles.databaseHeadingActions}>
                    <span>
                      {formatBytes(quotaUsage)} {database.hardLimitEnforced ? "on disk" : "used"} ·{" "}
                      {database.hardLimitEnforced ? "cap" : "target"}{" "}
                      {formatBytes(recommendedMaxBytes)}
                    </span>
                    {onSaveQuota ? (
                      <div className={styles.quotaAction}>
                        <button
                          aria-describedby={
                            database.hardLimitEnforced ? undefined : `quota-help-${database.name}`
                          }
                          aria-expanded={isEditing}
                          aria-controls={isEditing ? `quota-editor-${database.name}` : undefined}
                          className={styles.quotaButton}
                          disabled={!database.hardLimitEnforced || Boolean(savingQuotaName)}
                          onClick={() => startEditing(database)}
                          type="button"
                        >
                          {isEditing ? "Editing limit" : "Edit limit"}
                        </button>
                        {!database.hardLimitEnforced ? (
                          <small className={styles.quotaHint} id={`quota-help-${database.name}`}>
                            A verified hard quota is required before this limit can be changed.
                          </small>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div
                  aria-label={`${database.name}: ${formatBytes(quotaUsage)} used, ${formatBytes(growthHeadroomBytes)} ${database.hardLimitEnforced ? "remaining before hard limit" : "estimated growth room"}`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(fill)}
                  className={styles.track}
                  role="progressbar"
                >
                  <span className={styles.databaseFill} style={{ width: `${fill}%` }} />
                </div>
                <div className={styles.databaseMeta}>
                  <span>
                    {growthHeadroomBytes
                      ? `${formatBytes(growthHeadroomBytes)} ${database.hardLimitEnforced ? "left before cap" : "estimated growth room"}`
                      : database.hardLimitEnforced
                        ? "At cap"
                        : "No estimated growth room"}
                  </span>
                  <span>
                    {database.quotaMode === "custom"
                      ? database.hardLimitEnforced
                        ? "Custom cap"
                        : "Custom request"
                      : "Auto"}
                    {database.quotaConstrained ? " · reduced to fit disk budget" : ""}
                  </span>
                  <span>{Math.round(fill)}% of target</span>
                </div>
                {database.quotaConstrained && database.requestedMaxBytes ? (
                  <p className={styles.quotaWarning} role="note">
                    Requested {formatBytes(database.requestedMaxBytes)}; the effective cap is{" "}
                    {formatBytes(recommendedMaxBytes)} while the shared disk budget is tight.
                  </p>
                ) : null}
                {isEditing ? (
                  <form
                    className={styles.quotaEditor}
                    id={`quota-editor-${database.name}`}
                    onSubmit={(event) => void submitQuota(event, database)}
                  >
                    <div className={styles.quotaFields}>
                      <div>
                        <label htmlFor={`quota-mode-${database.name}`}>Sizing mode</label>
                        <Select
                          disabled={isSaving}
                          id={`quota-mode-${database.name}`}
                          onChange={(value) => {
                            setQuotaMode(value as "auto" | "custom");
                            setQuotaError(null);
                          }}
                          value={quotaMode}
                        >
                          <option value="auto">Auto allocation</option>
                          <option value="custom">Custom maximum</option>
                        </Select>
                      </div>
                      {quotaMode === "custom" ? (
                        <div>
                          <label htmlFor={`quota-size-${database.name}`}>Maximum size (GiB)</label>
                          <input
                            autoComplete="off"
                            disabled={isSaving}
                            id={`quota-size-${database.name}`}
                            max={quotaInputValue(maximumCustomMaxBytes)}
                            min={quotaInputValue(Math.max(quotaUsage, database.sizeBytes))}
                            onChange={(event) => {
                              setQuotaSizeGiB(event.target.value);
                              setQuotaError(null);
                            }}
                            required
                            step="any"
                            type="number"
                            value={quotaSizeGiB}
                          />
                        </div>
                      ) : null}
                    </div>
                    <p>
                      Current use: {formatBytes(quotaUsage)}. Custom maximum available now:{" "}
                      {formatBytes(maximumCustomMaxBytes)}. Automatic databases share the growth
                      room that remains; the enforced maximum can adjust as free disk changes.
                    </p>
                    {quotaError ? (
                      <p className={styles.quotaError} role="alert">
                        {quotaError}
                      </p>
                    ) : null}
                    <div className={styles.quotaActions}>
                      <button
                        className={styles.quotaButton}
                        disabled={isSaving}
                        onClick={() => setEditingName(null)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button className={styles.quotaSave} disabled={isSaving} type="submit">
                        {isSaving ? "Saving…" : "Save limit"}
                      </button>
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.empty}>Create a user database to see its growth room.</p>
      )}

      {!quotaEnforced ? (
        <p className={styles.advisoryNote} role="note">
          These targets update with free disk space, but are not hard limits. PostgreSQL does not
          enforce per-database size caps; filesystem project quotas must be enabled and verified in
          the system to stop a database at its target.{" "}
          {enforcementReason ?? "The quota filesystem is not active yet."}
        </p>
      ) : null}
      {quotaEnforced ? (
        <p className={styles.advisoryNote} role="note">
          Database totals use allocated blocks in each database directory. Hard caps apply to the
          primary PostgreSQL tablespace; shared WAL, backups, and server files also use system disk
          space, so the database total is lower than total disk usage.
        </p>
      ) : null}
    </div>
  );
}
