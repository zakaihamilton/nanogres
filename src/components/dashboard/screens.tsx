import type { ReactNode } from "react";
import { Icon } from "./icons";
import styles from "./screens.module.css";
import {
  LiveAccessScreen,
  LiveActivityScreen,
  LiveBackupsScreen,
  LiveDatabasesScreen,
  LiveOverviewScreen,
} from "./live-screens";

type ScreenMode = "live" | "preview";

type ScreenProps = {
  mode: ScreenMode;
};

type DatabaseRow = {
  name: string;
  owner: string;
  size: string;
  connections: string;
  updated: string;
  state: "Healthy" | "Idle" | "Maintenance";
};

const demoDatabases: DatabaseRow[] = [
  {
    name: "app_main",
    owner: "app_service",
    size: "1.8 GB",
    connections: "8 / 100",
    updated: "2 min ago",
    state: "Healthy",
  },
  {
    name: "event_store",
    owner: "worker_role",
    size: "426 MB",
    connections: "3 / 50",
    updated: "8 min ago",
    state: "Healthy",
  },
  {
    name: "sandbox",
    owner: "dev_role",
    size: "74 MB",
    connections: "0 / 20",
    updated: "3 hours ago",
    state: "Idle",
  },
];

function ScreenHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: string;
}) {
  return (
    <div className={styles.pageHeading}>
      <div>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p className={styles.headingDescription}>{description}</p>
      </div>
      {action ? (
        <button
          className={styles.primaryButton}
          disabled
          title="Available when the VPS API is connected"
          type="button"
        >
          <Icon name="plus" size={16} />
          {action}
        </button>
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

function DataTable({ columns, children }: { columns: TableColumn[]; children: ReactNode }) {
  return (
    <div className={styles.tableWrap}>
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

function StaticRowAction({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button aria-label={label} className={styles.rowAction} disabled type="button">
      {children}
    </button>
  );
}

function DatabaseTable({ rows }: { rows: DatabaseRow[] }) {
  return (
    <DataTable
      columns={[
        { id: "database", label: "Database" },
        { id: "owner", label: "Owner" },
        { id: "size", label: "Size" },
        { id: "connections", label: "Connections" },
        { id: "status", label: "Status" },
        { id: "updated", label: "Updated" },
        { id: "open", label: "Open", visuallyHidden: true },
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
          <td>
            <StatePill state={row.state} />
          </td>
          <td className={styles.mutedCell}>{row.updated}</td>
          <td>
            <StaticRowAction label={`Open ${row.name}`}>
              <Icon name="arrow" size={15} />
            </StaticRowAction>
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
    <section className={`${styles.panel} ${className}`}>
      <div className={styles.panelHeading}>
        <div>
          <h2>{title}</h2>
          {detail ? <p>{detail}</p> : null}
        </div>
        <button
          aria-label={`More about ${title}`}
          className={styles.moreButton}
          disabled
          type="button"
        >
          ···
        </button>
      </div>
      {children}
    </section>
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

export function OverviewScreen({ mode }: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveOverviewScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        action="New database"
        description="Your Postgres databases and operational health, in one place."
        eyebrow="OVERVIEW"
        title="Postgres, at a glance."
      />
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
            <DatabaseTable rows={demoDatabases} />
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
            </div>
          </div>
        </Panel>
      </div>

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

export function DatabasesScreen({ mode }: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveDatabasesScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        action="Create database"
        description="Create and manage isolated Postgres databases on your VPS."
        eyebrow="DATA"
        title="Databases"
      />
      {!preview ? <ApiNotice /> : null}
      <Panel
        detail={
          preview
            ? "3 databases · sorted by recent activity"
            : "Database inventory is not connected yet"
        }
        title="All databases"
      >
        {preview ? (
          <DatabaseTable rows={demoDatabases} />
        ) : (
          <EmptyState
            description="Once the VPS API is ready, your databases and usage details will appear here."
            title="Waiting for the VPS API"
          />
        )}
      </Panel>
      <div className={styles.footerHint}>
        <Icon name="shield" size={15} />
        <span>Database operations will require an active Perminister grant.</span>
      </div>
    </div>
  );
}

export function DatabaseDetailScreen({ mode }: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveDatabasesScreen />;
  return (
    <div className={styles.screen}>
      <div className={styles.detailCrumb}>
        <span>Databases</span>
        <span aria-hidden="true">/</span>
        <strong>{preview ? "app_main" : "Database details"}</strong>
      </div>
      <ScreenHeading
        description="Configuration and usage for this database."
        eyebrow="DATABASE DETAILS"
        title={preview ? "app_main" : "Database detail"}
      />
      {!preview ? <ApiNotice /> : null}
      <div className={styles.detailGrid}>
        <Panel detail="Database configuration" title="Overview">
          <dl className={styles.detailsList}>
            <div>
              <dt>Owner role</dt>
              <dd>{preview ? "app_service" : "—"}</dd>
            </div>
            <div>
              <dt>Encoding</dt>
              <dd>{preview ? "UTF8" : "—"}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{preview ? "Oct 18, 2026" : "—"}</dd>
            </div>
            <div>
              <dt>Last backup</dt>
              <dd>{preview ? "Today at 09:15" : "—"}</dd>
            </div>
          </dl>
        </Panel>
        <Panel detail="Current activity" title="Usage">
          <div className={styles.usageNumber}>
            {preview ? "8" : "—"}
            <span> / 100 connections</span>
          </div>
          <div className={styles.progressTrack}>
            <span style={{ width: preview ? "23%" : "0%" }} />
          </div>
          <p className={styles.usageCaption}>
            {preview
              ? "23% of the connection limit is in use."
              : "Usage will appear when connected."}
          </p>
        </Panel>
      </div>
      <Panel detail="Only credentials created for this database" title="Database roles">
        {preview ? (
          <RoleTable compact />
        ) : (
          <EmptyState
            description="Role and password controls will be available after connecting the API."
            title="No role data yet"
          />
        )}
      </Panel>
    </div>
  );
}

export function AccessScreen({ mode }: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveAccessScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        action="Invite member"
        description="Manage who can access Nanogres and what they can do."
        eyebrow="SECURITY"
        title="Access & roles"
      />
      {!preview ? <ApiNotice /> : null}
      <div className={styles.accessNotice}>
        <span>
          <Icon name="shield" size={18} />
        </span>
        <p>
          <strong>Permissions are checked on the server.</strong> Perminister grants control which
          database actions each member can use.
        </p>
      </div>
      <Panel
        detail={
          preview
            ? "2 people · managed in Perminister"
            : "Membership and grants will sync from Perminister"
        }
        title="Workspace members"
      >
        {preview ? (
          <RoleTable />
        ) : (
          <EmptyState
            description="Once Perminister is connected, workspace members and their grants will appear here."
            title="Waiting for access data"
          />
        )}
      </Panel>
    </div>
  );
}

export function BackupsScreen({ mode }: ScreenProps) {
  const preview = mode === "preview";
  if (!preview) return <LiveBackupsScreen />;
  return (
    <div className={styles.screen}>
      <ScreenHeading
        action="Create & download .dump"
        description="Review scheduled and completed database backups."
        eyebrow="RECOVERY"
        title="Backups"
      />
      {!preview ? <ApiNotice /> : null}
      <div className={styles.backupSummary}>
        <div>
          <span className={styles.summaryIcon}>
            <Icon name="backup" size={18} />
          </span>
          <span>
            <small>Retention</small>
            <strong>{preview ? "7 daily copies" : "Not configured"}</strong>
          </span>
        </div>
        <div>
          <span className={styles.summaryIcon}>
            <Icon name="clock" size={18} />
          </span>
          <span>
            <small>Next scheduled</small>
            <strong>{preview ? "Tomorrow · 02:00 UTC" : "—"}</strong>
          </span>
        </div>
        <div>
          <span className={styles.summaryIcon}>
            <Icon name="database" size={18} />
          </span>
          <span>
            <small>Storage</small>
            <strong>{preview ? "VPS local volume" : "—"}</strong>
          </span>
        </div>
      </div>
      <Panel
        detail="Upload a trusted custom-format dump and restore it into a fresh database."
        title="Restore from a file"
      >
        <div className={styles.filePreview}>
          <div>
            <strong>PostgreSQL dump</strong>
            <small>.dump or .backup · creates a separate database</small>
          </div>
          <button className={styles.primaryButton} disabled type="button">
            Choose file to restore
          </button>
        </div>
      </Panel>
      <Panel
        detail={
          preview ? "Automatic and manual backups" : "Backup history will appear after connection"
        }
        title="Recent backups"
      >
        {preview ? (
          <BackupTable />
        ) : (
          <EmptyState
            description="Backup history and restore points will appear when the VPS API is connected."
            title="No backup history yet"
          />
        )}
      </Panel>
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
        description="A history of database operations and access changes."
        eyebrow="AUDIT TRAIL"
        title="Activity"
      />
      {!preview ? <ApiNotice /> : null}
      <Panel
        detail={preview ? "Last 7 days" : "Events will appear after connection"}
        title="Recent events"
      >
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

function RoleTable({ compact = false }: { compact?: boolean }) {
  const members = [
    { name: "Avery Morgan", email: "avery@example.test", role: "Owner", access: "All actions" },
    {
      name: "Jordan Lee",
      email: "jordan@example.test",
      role: "Developer",
      access: "Read, create, backup",
    },
  ];
  return (
    <DataTable
      columns={[
        { id: "member", label: compact ? "Role" : "Member" },
        { id: "access", label: "Access" },
        { id: "scope", label: "Scope" },
        { id: "options", label: "Options", visuallyHidden: true },
      ]}
    >
      {members.map((member) => (
        <tr key={member.email}>
          <td>
            <span className={styles.memberCell}>
              <span className={styles.memberAvatar}>
                {member.name
                  .split(" ")
                  .map((part) => part[0])
                  .join("")}
              </span>
              <span>
                <strong>{compact ? member.role : member.name}</strong>
                {!compact ? <small>{member.email}</small> : null}
              </span>
            </span>
          </td>
          <td>{member.access}</td>
          <td className={styles.mutedCell}>Workspace</td>
          <td>
            <StaticRowAction label={`More options for ${member.name}`}>···</StaticRowAction>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

function BackupTable() {
  const backups = [
    {
      database: "app_main",
      kind: "Scheduled",
      time: "Today, 09:15",
      size: "184 MB",
      state: "Complete",
    },
    {
      database: "event_store",
      kind: "Scheduled",
      time: "Today, 09:10",
      size: "42 MB",
      state: "Complete",
    },
    {
      database: "app_main",
      kind: "Manual",
      time: "Yesterday, 16:48",
      size: "179 MB",
      state: "Complete",
    },
  ];
  return (
    <DataTable
      columns={[
        { id: "database", label: "Database" },
        { id: "type", label: "Type" },
        { id: "created", label: "Created" },
        { id: "size", label: "Size" },
        { id: "status", label: "Status" },
        { id: "options", label: "Options", visuallyHidden: true },
      ]}
    >
      {backups.map((backup, index) => (
        <tr key={`${backup.database}-${backup.time}`}>
          <td>
            <strong>{backup.database}</strong>
          </td>
          <td className={styles.mutedCell}>{backup.kind}</td>
          <td className={styles.mutedCell}>{backup.time}</td>
          <td>{backup.size}</td>
          <td>
            <span className={`${styles.statePill} ${styles.stateHealthy}`}>{backup.state}</span>
          </td>
          <td>
            <StaticRowAction label={`Restore backup ${index + 1} as a new database`}>
              Restore
            </StaticRowAction>
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
