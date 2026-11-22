// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Keyboard-focusable dashboard regions allow keyboard scrolling of wide tables.
import type { ReactNode } from "react";
import { Icon } from "../icons";
import { PanelFrame } from "../panel-frame";
import styles from "./primitives.module.css";
import type { DatabaseRow } from "./scenarios";

export function ScreenHeading({
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
              Available when the VPS server is connected
            </small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ApiNotice() {
  return (
    <div className={styles.apiNotice}>
      <span className={styles.noticeIcon}>
        <Icon name="server" size={17} />
      </span>
      <div>
        <strong>Server connection pending</strong>
        <p>
          The dashboard is ready for your Postgres server. Live inventory and controls will appear
          here once the private VPS API is connected.
        </p>
      </div>
      <span className={styles.pendingPill}>NOT CONNECTED</span>
    </div>
  );
}

export function MetricCard({
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

export function DataTable({
  columns,
  label,
  children,
}: {
  columns: TableColumn[];
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.tableRegion}>
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
      <p className={styles.tableScrollHint}>Swipe horizontally to see all columns</p>
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

export function DatabaseTable({
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
              {row.systemDatabase ? <small className={styles.systemBadge}>System</small> : null}
            </span>
          </td>
          <td className={styles.mutedCell}>{row.owner}</td>
          <td>{row.size}</td>
          <td className={styles.mutedCell}>{row.connections}</td>
          <td>{management ? row.encoding : <StatePill state={row.state} />}</td>
          {!management ? <td className={styles.mutedCell}>{row.updated}</td> : null}
          <td>
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

export function Panel({
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

export function EmptyState({ title, description }: { title: string; description: string }) {
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

export function ActivityList({ compact = false }: { compact?: boolean }) {
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
