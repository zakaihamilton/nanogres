import { Select } from "@/components/ui/select";
import { TENANT_NAME_MAX_LENGTH, TENANT_NAME_PATTERN } from "@/lib/tenant-names";
import { Icon } from "../icons";
import formStyles from "./forms-preview.module.css";
import { DataTable, EmptyState, Panel, ScreenHeading } from "./primitives";
import styles from "./primitives.module.css";
import type { PreviewScenario } from "./scenarios";

function BackupTable({
  onRestore,
  previewScenario,
}: {
  onRestore?: (database: string) => void;
  previewScenario: PreviewScenario;
}) {
  const backups = [
    {
      database: "app_main",
      time: previewScenario === "backups-stale" ? "Nov 9, 09:15" : "Today, 09:15",
      size: "184 MB",
      status:
        previewScenario === "backups-stale"
          ? "Stale"
          : previewScenario === "backups-failed"
            ? "Failed"
            : "Verified",
    },
    {
      database: "event_store",
      time: previewScenario === "backups-stale" ? "Nov 9, 09:10" : "Today, 09:10",
      size: "42 MB",
      status: "Verified",
    },
    {
      database: "app_main",
      time: previewScenario === "backups-stale" ? "Nov 8, 16:48" : "Yesterday, 16:48",
      size: "179 MB",
      status: "Verified",
    },
  ];
  return (
    <DataTable
      label="Backup history"
      columns={[
        { id: "database", label: "Database" },
        { id: "created", label: "Created" },
        { id: "size", label: "Size" },
        { id: "status", label: "Status" },
        { id: "actions", label: "Actions", visuallyHidden: true },
      ]}
    >
      {backups.map((backup) => (
        <tr key={`${backup.database}-${backup.time}`}>
          <td>
            <strong>{backup.database}</strong>
          </td>
          <td className={styles.mutedCell}>{backup.time}</td>
          <td>{backup.size}</td>
          <td>{backup.status}</td>
          <td>
            <div className={formStyles.backupPreviewActions}>
              <div className={formStyles.previewDownloadAction}>
                <button disabled type="button">
                  Download file
                </button>
                <small className={styles.previewActionHint}>Preview only</small>
              </div>
              <button
                aria-label={`Restore as new: ${backup.database} backup from ${backup.time}`}
                disabled={!onRestore}
                type="button"
                onClick={() => onRestore?.(backup.database)}
              >
                Restore as new
              </button>
            </div>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

export function BackupsScreen({
  onPreviewNavigate,
  previewPage = "list",
  previewBackup = "app_main",
  previewScenario = "healthy",
  readOnly = false,
}: {
  onPreviewNavigate?: (screen: string) => void;
  previewPage?: "list" | "new" | "restore" | "restore-existing";
  previewBackup?: string;
  previewScenario?: PreviewScenario;
  readOnly?: boolean;
}) {
  const backupsConfigured = previewScenario !== "backups-unconfigured";
  const backupNotice =
    previewScenario === "backups-stale"
      ? "The latest scheduled backup is four days old. The next run has not completed."
      : previewScenario === "backups-failed"
        ? "The latest backup failed because the remote storage destination could not be reached."
        : previewScenario === "backups-unconfigured"
          ? "No backup schedule or remote destination is configured for this organization."
          : null;

  return (
    <div className={styles.screen}>
      <ScreenHeading
        description="Daily recovery points, on-demand snapshots, and off-site copies."
        eyebrow="RECOVERY"
        title="Backups"
      />
      {previewPage === "list" ? (
        <>
          {backupNotice ? (
            <div
              className={styles.previewNotice}
              role={previewScenario === "backups-failed" ? "alert" : "status"}
            >
              {backupNotice}
            </div>
          ) : null}
          <div className={formStyles.backupPageActions}>
            <button
              className={styles.primaryButton}
              disabled={readOnly}
              type="button"
              onClick={() => onPreviewNavigate?.("backups-new")}
            >
              Create backup
            </button>{" "}
            <button
              className={styles.secondaryButton}
              disabled={readOnly}
              type="button"
              onClick={() => onPreviewNavigate?.("backups-restore")}
            >
              Restore from file
            </button>
          </div>
          <div className={formStyles.backupSummary}>
            <div>
              <span className={formStyles.summaryIcon}>
                <Icon name="backup" size={18} />
              </span>
              <span>
                <small>Schedule</small>
                <strong>
                  {backupsConfigured ? "Daily near 02:00 UTC" : "Not configured"}
                </strong>
              </span>
            </div>
            <div>
              <span className={formStyles.summaryIcon}>
                <Icon name="clock" size={18} />
              </span>
              <span>
                <small>Retention</small>
                <strong>{backupsConfigured ? "14 days locally" : "No retention policy"}</strong>
              </span>
            </div>
            <div>
              <span className={formStyles.summaryIcon}>
                <Icon name="database" size={18} />
              </span>
              <span>
                <small>Destination</small>
                <strong>{backupsConfigured ? "Local disk + S3 Storage" : "Not connected"}</strong>
              </span>
            </div>
          </div>
          {backupsConfigured ? (
            <div className={styles.previewNotice} role="status">
              {previewScenario === "backups-stale"
                ? "The latest off-site copy is also four days old. Older S3 copies remain available after local 14-day retention."
                : previewScenario === "backups-failed"
                  ? "The latest backup did not reach off-site storage. Older verified copies remain available."
                  : "The latest off-site copy was verified today. Older S3 copies remain available after local 14-day retention."}
            </div>
          ) : null}
          <Panel
            detail={backupsConfigured ? "3 retained files" : "No retained files"}
            title="Backup history"
          >
            {backupsConfigured ? (
              <BackupTable
                onRestore={
                  readOnly
                    ? undefined
                    : (database) => onPreviewNavigate?.(`backups-restore-existing:${database}`)
                }
                previewScenario={previewScenario}
              />
            ) : (
              <EmptyState
                description="Set a schedule and destination to start retaining recovery points."
                title="No backups yet"
              />
            )}
          </Panel>
        </>
      ) : previewPage === "new" ? (
        <Panel
          title="Create a backup now"
          detail="Create a PostgreSQL dump and save a copy to your device."
        >
          <div className={formStyles.previewInlineForm}>
            <label className={styles.srOnly} htmlFor="preview-backup-database">
              Database
            </label>
            <Select defaultValue="app_main" id="preview-backup-database" name="database">
              <option value="app_main">app_main</option>
              <option value="event_store">event_store</option>
              <option value="sandbox">sandbox</option>
            </Select>
            <div className={styles.previewAction}>
              <button disabled type="button">
                Create &amp; download .dump
              </button>
              <small className={styles.previewActionHint}>
                Preview only · no backup file will be created.
              </small>
            </div>
          </div>
        </Panel>
      ) : previewPage === "restore-existing" ? (
        <Panel title="Restore a backup" detail="Restore this recovery point into a new database.">
          <div className={formStyles.restoreExistingForm}>
            <p className={formStyles.restoreExistingSummary}>
              Backup: <strong>{previewBackup} backup</strong>
            </p>
            <div className={formStyles.previewField}>
              <label htmlFor="preview-existing-name">New database name</label>
              <input
                id="preview-existing-name"
                defaultValue={`${previewBackup}_restore`}
                maxLength={TENANT_NAME_MAX_LENGTH}
                minLength={1}
                pattern={TENANT_NAME_PATTERN}
              />
              <small>
                Existing databases are never replaced. Max {TENANT_NAME_MAX_LENGTH} characters.
              </small>
            </div>
            <div className={formStyles.restoreExistingActions}>
              <small className={styles.previewActionHint}>
                Preview only. No database will be restored.
              </small>
              <button className={styles.primaryButton} disabled type="button">
                Restore
              </button>
            </div>
          </div>
        </Panel>
      ) : (
        <Panel
          detail="Upload a trusted custom-format dump and restore it into a fresh database."
          title="Restore from a file"
        >
          <div className={formStyles.restorePreviewForm}>
            <div className={formStyles.previewField}>
              <strong>PostgreSQL dump file</strong>
              <small>.dump or .backup · creates a separate database</small>
              <input
                aria-label="Choose a PostgreSQL dump file"
                accept=".dump,.backup"
                disabled
                type="file"
              />
            </div>
            <div className={formStyles.previewField}>
              <label htmlFor="preview-restore-database">New database name</label>
              <input
                id="preview-restore-database"
                maxLength={TENANT_NAME_MAX_LENGTH}
                pattern={TENANT_NAME_PATTERN}
                placeholder="restored_project"
                disabled
              />
            </div>
            <div className={styles.previewAction}>
              <button className={styles.primaryButton} disabled type="button">
                Restore from file
              </button>
              <small className={styles.previewActionHint}>
                Preview only · no data will be restored.
              </small>
            </div>
          </div>
        </Panel>
      )}
      <div className={styles.footerHint}>
        <Icon name="shield" size={15} />
        <span>
          Restore creates a separate database after confirmation; it never overwrites existing data.
        </span>
      </div>
    </div>
  );
}
