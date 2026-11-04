import type { FormEvent, ReactNode } from "react";
import { Icon } from "./icons";
import { PanelFrame } from "./panel-frame";
import { Select } from "@/components/ui/select";
import { StorageCapacity, type DatabaseStorage, type StorageDisk } from "./storage-capacity";
import styles from "./screens.module.css";
import {
  LiveAccessScreen,
  LiveActivityScreen,
  LiveBackupsScreen,
  LiveDatabasesScreen,
  FirstRunCard,
  LiveOverviewScreen,
} from "./live-screens";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard-focusable regions let users scroll wide data tables on small screens. */

type ScreenMode = "live" | "preview";

type ScreenProps = {
  mode: ScreenMode;
  previewPage?: "list" | "new" | "restore" | "restore-existing";
  previewBackup?: string;
  onPreviewNavigate?: (screen: string) => void;
  onPreviewDelete?: (database: DatabaseRow) => void;
  onPreviewCreateDatabase?: (name: string) => void;
  onPreviewCreateRole?: (name: string) => void;
  previewNotice?: string | null;
};

type DatabaseRow = DatabaseStorage & {
  name: string;
  owner: string;
  size: string;
  sizeBytes: number;
  growthHeadroomBytes: number;
  recommendedMaxBytes: number;
  hardLimitEnforced: boolean;
  systemDatabase: boolean;
  connections: string;
  updated: string;
  encoding: string;
  state: "Healthy" | "Idle" | "Maintenance";
};

const gib = 1024 ** 3;
const demoDisk: StorageDisk = {
  totalBytes: 40 * gib,
  usedBytes: 13 * gib,
  freeBytes: 27 * gib,
};
const demoGrowthHeadroom = (Math.max(0, demoDisk.freeBytes - gib) * 0.25) / 3;

const demoDatabases: DatabaseRow[] = [
  {
    name: "postgres",
    owner: "postgres",
    size: "16 MB",
    sizeBytes: 16 * 1024 ** 2,
    growthHeadroomBytes: 0,
    recommendedMaxBytes: 16 * 1024 ** 2,
    hardLimitEnforced: false,
    systemDatabase: true,
    connections: "2 / 100",
    updated: "Now",
    encoding: "UTF8",
    state: "Healthy",
  },
  {
    name: "app_main",
    owner: "app_service",
    size: "1.8 GB",
    sizeBytes: 1.8 * gib,
    growthHeadroomBytes: demoGrowthHeadroom,
    recommendedMaxBytes: 1.8 * gib + demoGrowthHeadroom,
    hardLimitEnforced: false,
    systemDatabase: false,
    connections: "8 / 100",
    updated: "2 min ago",
    encoding: "UTF8",
    state: "Healthy",
  },
  {
    name: "event_store",
    owner: "worker_role",
    size: "426 MB",
    sizeBytes: 426 * 1024 ** 2,
    growthHeadroomBytes: demoGrowthHeadroom,
    recommendedMaxBytes: 426 * 1024 ** 2 + demoGrowthHeadroom,
    hardLimitEnforced: false,
    systemDatabase: false,
    connections: "3 / 50",
    updated: "8 min ago",
    encoding: "UTF8",
    state: "Healthy",
  },
  {
    name: "sandbox",
    owner: "dev_role",
    size: "74 MB",
    sizeBytes: 74 * 1024 ** 2,
    growthHeadroomBytes: demoGrowthHeadroom,
    recommendedMaxBytes: 74 * 1024 ** 2 + demoGrowthHeadroom,
    hardLimitEnforced: false,
    systemDatabase: false,
    connections: "0 / 20",
    updated: "3 hours ago",
    encoding: "UTF8",
    state: "Idle",
  },
];

function ScreenHeading({
  eyebrow,
  title,
  description,
  action,
  onAction,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className={styles.pageHeading}>
      <div>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p className={styles.headingDescription}>{description}</p>
      </div>
      {action ? (
        <div className={styles.headingAction}>
          <button
            className={styles.primaryButton}
            disabled={!onAction}
            onClick={onAction}
            type="button"
          >
            <Icon name="plus" size={16} />
            {action}
          </button>
          {!onAction ? (
            <small className={styles.previewActionHint}>
              Available when the VPS API is connected
            </small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ApiNotice() {
  return (
    <div className={styles.apiNotice}>
      <span className={styles.noticeIcon}>
        <Icon name="server" size={17} />
      </span>
      <div>
        <strong>VPS API connection pending</strong>
        <p>
          The dashboard is ready for your Postgres server. Live inventory and controls will appear
          here once the HTTPS management API is connected.
        </p>
      </div>
      <span className={styles.pendingPill}>NOT CONNECTED</span>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "green",
}: {
  label: string;
  value: string;
  detail: string;
  icon: "database" | "activity" | "backup" | "access";
  tone?: "green" | "blue" | "amber";
}) {
  return (
    <section className={styles.metricCard}>
      <div className={styles.metricTop}>
        <span>{label}</span>
        <span className={`${styles.metricIcon} ${styles[`tone_${tone}`]}`}>
          <Icon name={icon} size={17} />
        </span>
      </div>
      <strong className={styles.metricValue}>{value}</strong>
      <span className={styles.metricDetail}>{detail}</span>
    </section>
  );
}

function StatePill({ state }: { state: DatabaseRow["state"] }) {
  const className =
    state === "Healthy"
      ? styles.stateHealthy
      : state === "Idle"
        ? styles.stateIdle
        : styles.stateMaintenance;
  return <span className={`${styles.statePill} ${className}`}>{state}</span>;
}

type TableColumn = {
  id: string;
  label: string;
  visuallyHidden?: boolean;
};

function DataTable({
  columns,
  label,
  children,
}: {
  columns: TableColumn[];
  label: string;
  children: ReactNode;
}) {
  return (
    <div aria-label={label} className={styles.tableWrap} role="region" tabIndex={0}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col">
                {column.visuallyHidden ? (
                  <span className={styles.srOnly}>{column.label}</span>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function StaticRowAction({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={styles.rowAction}
      disabled={!onClick}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function DatabaseTable({
  rows,
  variant = "overview",
  onOpen,
  onDelete,
}: {
  rows: DatabaseRow[];
  variant?: "overview" | "management";
  onOpen?: (name: string) => void;
  onDelete?: (row: DatabaseRow) => void;
}) {
  const management = variant === "management";
  return (
    <DataTable
      label="Databases"
      columns={[
        { id: "database", label: "Database" },
        { id: "owner", label: "Owner" },
        { id: "size", label: "Size" },
        { id: "connections", label: "Connections" },
        { id: management ? "encoding" : "status", label: management ? "Encoding" : "Status" },
        ...(management ? [] : [{ id: "updated", label: "Updated" }]),
        { id: "actions", label: management ? "Actions" : "Open", visuallyHidden: true },
      ]}
    >
      {rows.map((row) => (
        <tr key={row.name}>
          <td>
            <span className={styles.dbName}>
              <span className={styles.dbGlyph}>
                <Icon name="database" size={15} />
              </span>
              <strong>{row.name}</strong>
            </span>
          </td>
          <td className={styles.mutedCell}>{row.owner}</td>
          <td>{row.size}</td>
          <td className={styles.mutedCell}>{row.connections}</td>
          <td>{management ? row.encoding : <StatePill state={row.state} />}</td>
          {!management ? <td className={styles.mutedCell}>{row.updated}</td> : null}
          <td className={management ? styles.actionCell : undefined}>
            {management ? (
              row.systemDatabase ? (
                <span>Protected</span>
              ) : (
                <div className={styles.previewAction}>
                  <button
                    aria-label={`Delete ${row.name}`}
                    className={styles.deleteAction}
                    disabled={!onDelete}
                    onClick={() => onDelete?.(row)}
                    type="button"
                  >
                    Delete
                  </button>
                  {!onDelete ? (
                    <small className={styles.previewActionHint}>Preview only</small>
                  ) : null}
                </div>
              )
            ) : (
              <StaticRowAction
                label={`Open ${row.name}`}
                onClick={onOpen ? () => onOpen(row.name) : undefined}
              >
                <Icon name="arrow" size={15} />
              </StaticRowAction>
            )}
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

function Panel({
  title,
  detail,
  children,
  className = "",
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <PanelFrame
      className={`${styles.panel} ${className}`}
      headingClassName={styles.panelHeading}
      title={title}
      detail={detail}
    >
      {children}
    </PanelFrame>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyIcon}>
        <Icon name="database" size={20} />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function DatabaseCreatePreviewForm({ onSubmit }: { onSubmit?: (name: string) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = String(formData.get("database-name") ?? "");
    onSubmit?.(name);
    form.reset();
  }

  return (
    <form className={styles.createForm} onSubmit={submit}>
      <label htmlFor="preview-database-name">Database name</label>
      <div className={styles.createFormRow}>
        <input
          autoComplete="off"
          id="preview-database-name"
          maxLength={63}
          minLength={2}
          name="database-name"
          pattern="[a-z][a-z0-9_]{1,62}"
          placeholder="my_project"
          required
        />
        <button className={styles.primaryButton} disabled={!onSubmit} type="submit">
          Create database
        </button>
      </div>
    </form>
  );
}

function RoleCreatePreviewForm({ onSubmit }: { onSubmit?: (name: string) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("role-name") ?? "");
    onSubmit?.(name);
    form.reset();
  }

  return (
    <form className={styles.previewFormGrid} onSubmit={submit}>
      <div className={styles.previewField}>
        <label htmlFor="preview-role-name">Role name</label>
        <input
          autoComplete="off"
          id="preview-role-name"
          maxLength={63}
          minLength={2}
          name="role-name"
          pattern="[a-z][a-z0-9_]{1,62}"
          placeholder="my_app_user"
          required
        />
      </div>
      <div className={styles.previewField}>
        <label htmlFor="preview-role-database">Database</label>
        <Select defaultValue="app_main" id="preview-role-database" name="database">
          <option value="app_main">app_main</option>
          <option value="event_store">event_store</option>
          <option value="sandbox">sandbox</option>
        </Select>
      </div>
      <div className={styles.previewField}>
        <label htmlFor="preview-role-access">Access level</label>
        <Select defaultValue="readwrite" id="preview-role-access" name="access">
          <option value="readwrite">Read and write</option>
          <option value="readonly">Read only</option>
        </Select>
      </div>
      <div className={styles.previewField}>
        <label htmlFor="preview-role-password">Initial password</label>
        <input
          autoComplete="new-password"
          id="preview-role-password"
          minLength={16}
          name="role-password"
          required
          type="password"
        />
        <small>Use at least 16 characters. Generate and store it in your password manager.</small>
      </div>
      <div className={styles.previewFormActions}>
        <button disabled={!onSubmit} type="submit">
          Create role
        </button>
      </div>
    </form>
  );
}

export function OverviewScreen({ mode, onPreviewNavigate, previewNotice }: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveOverviewScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        action="Create a database"
        description="Manage project databases, access, and recovery from one workspace."
        eyebrow="YOUR WORKSPACE"
        title="Your Postgres, in one place."
        onAction={() => onPreviewNavigate?.("databases")}
      />
      {previewNotice ? (
        <div className={styles.previewNotice} role="status">
          {previewNotice}
        </div>
      ) : null}
      {!preview ? <ApiNotice /> : null}

      <div className={styles.metrics}>
        <MetricCard
          detail={preview ? "Across your workspace" : "Waiting for the VPS API"}
          icon="database"
          label="Databases"
          value={preview ? "3" : "—"}
        />
        <MetricCard
          detail={preview ? "Across active databases" : "Waiting for the VPS API"}
          icon="activity"
          label="Active connections"
          tone="blue"
          value={preview ? "11" : "—"}
        />
        <MetricCard
          detail={preview ? "Most recent: today, 09:15" : "No backup schedule yet"}
          icon="backup"
          label="Latest backup"
          tone="green"
          value={preview ? "Today" : "—"}
        />
        <MetricCard
          detail={preview ? "Workspace permissions" : "Managed by Perminister"}
          icon="access"
          label="Access grants"
          tone="amber"
          value={preview ? "2" : "—"}
        />
      </div>

      <div className={styles.overviewGrid}>
        <Panel
          className={styles.databasePanel}
          detail={
            preview
              ? "3 databases · refreshed just now"
              : "Live inventory will appear after connection"
          }
          title="Databases"
        >
          {preview ? (
            <DatabaseTable rows={demoDatabases} onOpen={() => onPreviewNavigate?.("databases")} />
          ) : (
            <EmptyState
              description="Connect the VPS API to see database size, owners, and connection counts."
              title="No live inventory yet"
            />
          )}
        </Panel>

        <Panel detail="VPS health and connection status" title="Server health">
          <div className={styles.healthCard}>
            <div className={styles.healthStatus}>
              <span className={`${styles.healthOrb} ${preview ? styles.healthOrbGood : ""}`}>
                <Icon name={preview ? "check" : "clock"} size={18} />
              </span>
              <span>
                <strong>{preview ? "All systems healthy" : "Waiting for first check"}</strong>
                <small>
                  {preview ? "PostgreSQL 17 · running" : "Server health will load from the VPS API"}
                </small>
              </span>
            </div>
            <div className={styles.healthRows}>
              <div>
                <span>API endpoint</span>
                <strong>{preview ? "Connected" : "Not configured"}</strong>
              </div>
              <div>
                <span>Postgres</span>
                <strong>{preview ? "Healthy" : "Pending"}</strong>
              </div>
              <div>
                <span>Last checked</span>
                <strong>{preview ? "Just now" : "—"}</strong>
              </div>
              <div>
                <span>Off-site backup</span>
                <strong>{preview ? "Verified today" : "—"}</strong>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <Panel detail="Current VPS disk usage and estimated growth room" title="Storage capacity">
        <StorageCapacity databases={demoDatabases} disk={demoDisk} growthPercent={25} />
      </Panel>

      <div className={styles.lowerGrid}>
        <Panel detail="Recent changes across this workspace" title="Recent activity">
          {preview ? (
            <ActivityList compact />
          ) : (
            <EmptyState
              description="Database and access events will be listed here."
              title="No activity to show"
            />
          )}
        </Panel>
        <section className={styles.tipCard}>
          <span className={styles.tipIcon}>
            <Icon name="shield" size={19} />
          </span>
          <div>
            <p className={styles.eyebrow}>SECURE BY DEFAULT</p>
            <h2>Your database stays private.</h2>
            <p>
              Nanogres talks to the VPS API from the server. Postgres is never opened to the
              browser.
            </p>
          </div>
          <span className={styles.tipDecoration} aria-hidden="true">
            N
          </span>
        </section>
      </div>
    </div>
  );
}

export function GettingStartedScreen() {
  return (
    <div className={styles.screen}>
      <ScreenHeading
        description="A clear view of database health, storage, access, and recovery."
        eyebrow="YOUR WORKSPACE"
        title="Your Postgres, in one place."
      />
      <FirstRunCard error={null} />
    </div>
  );
}

export function DatabasesScreen({
  mode,
  onPreviewDelete,
  onPreviewNavigate,
  previewPage = "list",
  onPreviewCreateDatabase,
  previewNotice,
}: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveDatabasesScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        description="Create databases and review size, owners, and active connections."
        eyebrow="DATA"
        title="Databases"
      />
      {previewNotice ? (
        <div className={styles.previewNotice} role="status">
          {previewNotice}
        </div>
      ) : null}
      {previewPage === "new" ? (
        <>
          <button type="button" onClick={() => onPreviewNavigate?.("databases")}>
            ← Back to databases
          </button>
          <Panel
            detail="Names use lowercase letters, numbers, and underscores."
            title="Create a database"
          >
            <DatabaseCreatePreviewForm onSubmit={onPreviewCreateDatabase} />
          </Panel>
        </>
      ) : (
        <>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => onPreviewNavigate?.("database-new")}
          >
            Create database
          </button>
          <Panel
            detail={`${demoDatabases.length} database${demoDatabases.length === 1 ? "" : "s"}`}
            title="All databases"
          >
            <DatabaseTable rows={demoDatabases} variant="management" onDelete={onPreviewDelete} />
          </Panel>
          <Panel
            detail="Current VPS disk usage and per-database growth room"
            title="Storage capacity"
          >
            <StorageCapacity databases={demoDatabases} disk={demoDisk} growthPercent={25} />
          </Panel>
          <div className={styles.footerHint}>
            <Icon name="shield" size={15} />
            <span>Database operations will require an active Perminister grant.</span>
          </div>
        </>
      )}
    </div>
  );
}

export function AccessScreen({
  mode,
  onPreviewCreateRole,
  onPreviewNavigate,
  previewPage = "list",
  previewNotice,
}: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveAccessScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        description="Create least-privilege Postgres login roles for individual databases."
        eyebrow="SECURITY"
        title="Access & roles"
      />
      {previewNotice ? (
        <div className={styles.previewNotice} role="status">
          {previewNotice}
        </div>
      ) : null}
      <div className={styles.accessNotice}>
        <span>
          <Icon name="shield" size={18} />
        </span>
        <p>
          People and Nanogres permissions are managed in Perminister. These are database login roles
          for your applications.
        </p>
      </div>
      {previewPage === "new" ? (
        <>
          <button type="button" onClick={() => onPreviewNavigate?.("access")}>
            ← Back to login roles
          </button>
          <Panel
            title="Create a database role"
            detail="Passwords are never shown again after creation."
          >
            <RoleCreatePreviewForm onSubmit={onPreviewCreateRole} />
          </Panel>
        </>
      ) : (
        <>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => onPreviewNavigate?.("access-new")}
          >
            Create role
          </button>
          <Panel title="Login roles" detail="2 Postgres login roles">
            <RoleTable variant="access" />
          </Panel>
        </>
      )}
    </div>
  );
}

export function BackupsScreen({
  mode,
  onPreviewNavigate,
  previewPage = "list",
  previewBackup = "app_main",
}: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveBackupsScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        description="Daily recovery points, on-demand snapshots, and off-site copies."
        eyebrow="RECOVERY"
        title="Backups"
      />
      {previewPage === "list" ? (
        <>
          <div>
            <button
              className={styles.primaryButton}
              type="button"
              onClick={() => onPreviewNavigate?.("backups-new")}
            >
              Create backup
            </button>{" "}
            <button type="button" onClick={() => onPreviewNavigate?.("backups-restore")}>
              Restore from file
            </button>
          </div>
          <div className={styles.backupSummary}>
            <div>
              <span className={styles.summaryIcon}>
                <Icon name="backup" size={18} />
              </span>
              <span>
                <small>Schedule</small>
                <strong>Daily near 02:00 UTC</strong>
              </span>
            </div>
            <div>
              <span className={styles.summaryIcon}>
                <Icon name="clock" size={18} />
              </span>
              <span>
                <small>Retention</small>
                <strong>14 days locally</strong>
              </span>
            </div>
            <div>
              <span className={styles.summaryIcon}>
                <Icon name="database" size={18} />
              </span>
              <span>
                <small>Destination</small>
                <strong>VPS + DigitalOcean Spaces</strong>
              </span>
            </div>
          </div>
          <div className={styles.previewNotice} role="status">
            The latest off-site copy was verified today. Older Space copies remain available after
            local 14-day retention.
          </div>
          <Panel detail="3 retained files" title="Backup history">
            <BackupTable
              onRestore={(database) => onPreviewNavigate?.(`backups-restore-existing:${database}`)}
            />
          </Panel>
        </>
      ) : previewPage === "new" ? (
        <>
          <button type="button" onClick={() => onPreviewNavigate?.("backups")}>
            ← Back to backups
          </button>
          <Panel
            title="Create a backup now"
            detail="Create a PostgreSQL dump and save a copy to your device."
          >
            <div className={styles.previewInlineForm}>
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
        </>
      ) : previewPage === "restore-existing" ? (
        <>
          <button type="button" onClick={() => onPreviewNavigate?.("backups")}>
            ← Back to backups
          </button>
          <Panel title="Restore a backup" detail="Restore this recovery point into a new database.">
            <p>
              Backup: <strong>{previewBackup} backup</strong>
            </p>
            <div className={styles.previewField}>
              <label htmlFor="preview-existing-name">New database name</label>
              <input id="preview-existing-name" defaultValue={`${previewBackup}_restore`} />
              <small>Existing databases are never replaced.</small>
            </div>
            <button className={styles.primaryButton} disabled type="button">
              Restore
            </button>
            <p>Preview only. No database will be restored.</p>
          </Panel>
        </>
      ) : (
        <>
          <button type="button" onClick={() => onPreviewNavigate?.("backups")}>
            ← Back to backups
          </button>
          <Panel
            detail="Upload a trusted custom-format dump and restore it into a fresh database."
            title="Restore from a file"
          >
            <div className={styles.restorePreviewForm}>
              <div className={styles.previewField}>
                <strong>PostgreSQL dump file</strong>
                <small>.dump or .backup · creates a separate database</small>
                <input
                  aria-label="Choose a PostgreSQL dump file"
                  accept=".dump,.backup"
                  disabled
                  type="file"
                />
              </div>
              <div className={styles.previewField}>
                <label htmlFor="preview-restore-database">New database name</label>
                <input id="preview-restore-database" placeholder="restored_project" disabled />
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
        </>
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

export function ActivityScreen({ mode }: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveActivityScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        description="A server-side record of database, role, and backup operations."
        eyebrow="AUDIT TRAIL"
        title="Activity"
      />
      {!preview ? <ApiNotice /> : null}
      <Panel detail="Newest operations first" title="Recent events">
        {preview ? (
          <ActivityList />
        ) : (
          <EmptyState
            description="A server-side audit log will make every operation easy to review."
            title="No events to show"
          />
        )}
      </Panel>
    </div>
  );
}

function RoleTable({ variant }: { variant: "database" | "access" }) {
  const roles = [
    { name: "app_service", access: "Read and write", database: "app_main" },
    { name: "report_reader", access: "Read only", database: "event_store" },
  ];
  const databaseDetails = variant === "database";
  return (
    <DataTable
      label={databaseDetails ? "Database roles" : "Access roles"}
      columns={[
        { id: "role", label: "Role" },
        { id: "access", label: databaseDetails ? "Access" : "Privileges" },
        { id: "scope", label: databaseDetails ? "Database" : "Expires" },
      ]}
    >
      {roles.map((role) => (
        <tr key={role.name}>
          <td>
            <strong>{role.name}</strong>
          </td>
          <td>{role.access}</td>
          <td className={styles.mutedCell}>{databaseDetails ? role.database : "Never"}</td>
        </tr>
      ))}
    </DataTable>
  );
}

function BackupTable({ onRestore }: { onRestore: (database: string) => void }) {
  const backups = [
    {
      database: "app_main",
      time: "Today, 09:15",
      size: "184 MB",
    },
    {
      database: "event_store",
      time: "Today, 09:10",
      size: "42 MB",
    },
    {
      database: "app_main",
      time: "Yesterday, 16:48",
      size: "179 MB",
    },
  ];
  return (
    <DataTable
      label="Backup history"
      columns={[
        { id: "database", label: "Database" },
        { id: "created", label: "Created" },
        { id: "size", label: "Size" },
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
          <td>
            <div className={styles.backupPreviewActions}>
              <div className={styles.previewDownloadAction}>
                <button disabled type="button">
                  Download file
                </button>
                <small className={styles.previewActionHint}>Preview only</small>
              </div>
              <button
                aria-label={`Restore as new: ${backup.database} backup from ${backup.time}`}
                type="button"
                onClick={() => onRestore(backup.database)}
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

function ActivityList({ compact = false }: { compact?: boolean }) {
  const events = [
    {
      icon: "backup" as const,
      title: "Backup completed",
      detail: "app_main · 184 MB",
      time: "09:15",
    },
    {
      icon: "database" as const,
      title: "Database created",
      detail: "event_store · by Avery Morgan",
      time: "Yesterday",
    },
    {
      icon: "access" as const,
      title: "Access grant updated",
      detail: "Jordan Lee · Developer",
      time: "Oct 28",
    },
  ];
  return (
    <div className={`${styles.activityList} ${compact ? styles.activityCompact : ""}`}>
      {events.map((event) => (
        <div className={styles.activityItem} key={event.title}>
          <span className={styles.activityIcon}>
            <Icon name={event.icon} size={15} />
          </span>
          <span className={styles.activityCopy}>
            <strong>{event.title}</strong>
            <small>{event.detail}</small>
          </span>
          <time>{event.time}</time>
        </div>
      ))}
    </div>
  );
}
