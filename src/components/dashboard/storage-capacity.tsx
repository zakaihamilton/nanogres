import styles from "./storage-capacity.module.css";

export type StorageDisk = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
};

export type DatabaseStorage = {
  name: string;
  sizeBytes: number;
  growthHeadroomBytes?: number;
  recommendedMaxBytes?: number;
  quotaUsedBytes?: number;
  hardLimitEnforced?: boolean;
  systemDatabase: boolean;
};

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

export function StorageCapacity({
  disk,
  databases,
  growthPercent,
  enforcementReason,
}: {
  disk: StorageDisk;
  databases: DatabaseStorage[];
  growthPercent: number;
  enforcementReason?: string | null;
}) {
  const diskUsedPercent = percentage(disk.usedBytes, disk.totalBytes);
  const userDatabases = databases.filter((database) => !database.systemDatabase);
  const safeGrowthPercent = Math.min(50, Math.max(1, growthPercent));
  const perDatabaseHeadroom = userDatabases.length
    ? Math.floor((Math.max(0, disk.freeBytes) * safeGrowthPercent) / 100 / userDatabases.length)
    : 0;
  const quotaEnforced =
    userDatabases.length > 0 &&
    userDatabases.every((database) => database.hardLimitEnforced === true);

  return (
    <div className={styles.capacity}>
      <div className={styles.diskSummary}>
        <div className={styles.summaryHeading}>
          <div>
            <strong>VPS data volume</strong>
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
      </div>

      <div className={styles.policyHeader}>
        <div>
          <strong>Per-database growth room</strong>
          <span>
            {safeGrowthPercent}% of current free disk, shared evenly across user databases
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
            const quotaUsage = database.hardLimitEnforced
              ? (database.quotaUsedBytes ?? database.sizeBytes)
              : database.sizeBytes;
            const recommendedMaxBytes =
              database.recommendedMaxBytes ?? quotaUsage + perDatabaseHeadroom;
            const growthHeadroomBytes = Math.max(0, recommendedMaxBytes - quotaUsage);
            const fill = percentage(quotaUsage, recommendedMaxBytes);
            return (
              <li className={styles.databaseItem} key={database.name}>
                <div className={styles.databaseHeading}>
                  <code>{database.name}</code>
                  <span>
                    {formatBytes(quotaUsage)} {database.hardLimitEnforced ? "on disk" : "used"} ·
                    cap {formatBytes(recommendedMaxBytes)}
                  </span>
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
                    {formatBytes(growthHeadroomBytes)}{" "}
                    {database.hardLimitEnforced ? "left before limit" : "estimated growth room"}
                  </span>
                  <span>{Math.round(fill)}% of target</span>
                </div>
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
          enforce per-database size caps; filesystem project quotas must be enabled and verified on
          the VPS to stop a database at its target.{" "}
          {enforcementReason ?? "The quota filesystem is not active yet."}
        </p>
      ) : null}
      {quotaEnforced ? (
        <p className={styles.advisoryNote} role="note">
          Hard caps apply to files in the primary PostgreSQL tablespace. Shared WAL, backups, and
          server files still use the same VPS disk, so keep an eye on free space.
        </p>
      ) : null}
    </div>
  );
}
