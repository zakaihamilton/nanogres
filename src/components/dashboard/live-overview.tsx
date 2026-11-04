"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import { formatBytes, StorageCapacity } from "./storage-capacity";
import { ConnectionGauge, StorageDonut } from "@/components/ui/svg-charts";
import { ConnectionModal } from "@/components/ui/connection-modal";
import { useTelemetryStream } from "@/lib/use-stream";
import {
  type Database,
  type Backup,
  type ActivityEvent,
  type ServerStatus,
  useApiData,
  formatDate,
  PageHeader,
  PrimaryLink,
  Button,
  Panel,
  Notice,
  Loading,
  DatabaseTable,
  ErrorNotice,
  ActivityList,
  WorkspaceBootstrap,
} from "./live-shared";
import styles from "./live-screens.module.css";

export function LiveOverviewScreen() {
  const { data, error, loading, refresh } = useApiData<{
    status: ServerStatus;
    databases: Database[];
    backups: Backup[];
    activity: ActivityEvent[];
  }>("/api/nanogres/overview");

  const { telemetry, isLive } = useTelemetryStream(Boolean(data));
  const [connectModalOpen, setConnectModalOpen] = useState(false);

  const status = telemetry?.status ?? data?.status;
  const databases = data?.databases ?? [];
  const totalSize = databases.reduce((sum, database) => sum + database.sizeBytes, 0);
  const offsite = status?.offsiteBackup;
  const offsiteFreshness =
    offsite?.freshness ??
    (!offsite?.configured ? "not-configured" : offsite.lastSuccessAt ? "fresh" : "pending");
  const offsiteNotice =
    offsiteFreshness === "fresh"
      ? `Off-site backups are current. The latest successful copy is ${formatDate(offsite?.lastSuccessAt ?? "")}.`
      : offsiteFreshness === "stale"
        ? `The latest verified off-site copy is older than 36 hours (${formatDate(offsite?.lastSuccessAt ?? "")}). Check the backup service in your workspace.`
        : offsiteFreshness === "error"
          ? (offsite?.lastError ??
            "The latest off-site upload failed. Check the backup service logs.")
          : offsiteFreshness === "pending"
            ? "Off-site storage is configured, but a successful upload has not been verified yet."
            : "Backups are stored locally in the workspace. Configure off-site storage and verify the first upload.";

  const storageItems = status?.disk
    ? [
        { label: "Databases", bytes: totalSize, color: "var(--green)" },
        {
          label: "Quota Reserve",
          bytes: status.databaseQuotaReserveBytes ?? 1024 ** 3,
          color: "var(--amber)",
        },
        {
          label: "Free Disk",
          bytes: status.disk.freeBytes,
          color: "var(--blue)",
        },
      ]
    : [];

  return (
    <div className={styles.screen}>
      <PageHeader
        action={
          <div className={styles.actionGroup}>
            {status ? (
              <span
                className={`${styles.livePill} ${isLive ? "" : styles.livePillOffline}`}
                title={
                  isLive ? "Live real-time Server-Sent Events connected" : "Polling every 6 seconds"
                }
              >
                <span className={styles.pulsingDot} />
                {isLive ? "LIVE STREAM" : "POLLING"}
              </span>
            ) : null}
            <button
              className={styles.actionSecondaryButton}
              onClick={() => setConnectModalOpen(true)}
              type="button"
            >
              <Icon name="terminal" size={14} />
              Connect
            </button>
            <Link className={styles.actionSecondaryButton} href="/sql">
              <Icon name="sql" size={14} />
              SQL Editor
            </Link>
            <PrimaryLink href="/databases/new">Create database</PrimaryLink>
          </div>
        }
        description="Real-time connection load, storage allocation, and backup status."
        eyebrow="POSTGRESQL"
        title="Cluster Overview"
      />
      {loading && !data ? <Loading label="Connecting to workspace…" /> : null}
      {!loading && !data ? <FirstRunCard error={error} /> : null}
      {data && error ? <ErrorNotice error={error} onRetry={() => void refresh()} /> : null}
      {data && !status && !error ? (
        <ErrorNotice error="Server health is unavailable." onRetry={() => void refresh()} />
      ) : null}

      {status ? (
        <>
          <div className={styles.telemetryGrid}>
            <div className={styles.telemetryCard}>
              <div className={styles.telemetryCardHeader}>
                <h3>Active Connections</h3>
                <span>Real-time pool load</span>
              </div>
              <div className={styles.telemetryCardBody}>
                <ConnectionGauge
                  current={status.connections}
                  max={status.maxConnections || 100}
                  size={130}
                />
              </div>
            </div>
            <div className={styles.telemetryCard}>
              <div className={styles.telemetryCardHeader}>
                <h3>Disk & Storage Allocation</h3>
                <span>Workspace root filesystem</span>
              </div>
              <div className={styles.telemetryCardBody}>
                <StorageDonut items={storageItems} size={120} totalBytes={status.disk.totalBytes} />
              </div>
            </div>
          </div>

          <div className={styles.metrics}>
            <Metric
              label="Databases"
              value={String(databases.filter((item) => !item.systemDatabase).length)}
              detail="User databases"
            />
            <Metric
              label="Connections"
              value={String(status.connections)}
              detail={`Maximum ${status.maxConnections}`}
            />
            <Metric
              label="Database storage"
              value={formatBytes(totalSize)}
              detail="Across all databases"
            />
            <Metric
              label="Free disk"
              value={formatBytes(status.disk.freeBytes)}
              detail={`of ${formatBytes(status.disk.totalBytes)}`}
            />
          </div>
        </>
      ) : null}

      {data && status ? (
        <>
          <div className={styles.twoColumns}>
            <Panel
              title="Databases"
              detail={`${databases.length} total · ${formatBytes(totalSize)} used`}
            >
              <DatabaseTable databases={databases.slice(0, 6)} />
            </Panel>
            <Panel title="System health" detail="PostgreSQL workspace status">
              <div className={styles.health}>
                <span className={styles.healthyDot} />
                <div>
                  <strong>PostgreSQL is responding</strong>
                  <small>Version {status.postgresVersion}</small>
                </div>
                <Button onClick={() => void refresh()} variant="secondary">
                  Refresh
                </Button>
                <dl>
                  <div>
                    <dt>Started</dt>
                    <dd>{formatDate(status.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>Backup retention</dt>
                    <dd>{status.backupRetentionDays} days in workspace</dd>
                  </div>
                  <div>
                    <dt>Latest backup</dt>
                    <dd>
                      {data.backups[0] ? formatDate(data.backups[0].createdAt) : "No backups yet"}
                    </dd>
                  </div>
                  <div>
                    <dt>Off-site copy</dt>
                    <dd>
                      {offsiteFreshness === "fresh"
                        ? `Verified ${formatDate(offsite?.lastSuccessAt ?? "")}`
                        : offsiteFreshness === "stale"
                          ? `Stale · verified ${formatDate(offsite?.lastSuccessAt ?? "")}`
                          : offsiteFreshness === "error"
                            ? "Latest upload failed"
                            : offsiteFreshness === "pending"
                              ? "Waiting for first upload"
                              : "Not configured"}
                    </dd>
                  </div>
                </dl>
              </div>
            </Panel>
          </div>
          <Panel
            title="Storage capacity"
            detail="Disk usage and current growth room for each user database"
          >
            <StorageCapacity
              databases={databases}
              disk={status.disk}
              enforcementReason={status.databaseQuotaReason}
              growthPercent={status.databaseGrowthPercent ?? 25}
              reserveBytes={status.databaseQuotaReserveBytes}
            />
          </Panel>
          <Panel title="Recent activity" detail="Database and access changes in this workspace">
            <ActivityList error={null} events={data.activity} loading={false} />
          </Panel>
          <Notice
            tone={offsiteFreshness === "stale" || offsiteFreshness === "error" ? "warning" : "info"}
          >
            {offsiteNotice}
          </Notice>
        </>
      ) : null}

      <ConnectionModal
        database={databases[0]?.name || "postgres"}
        isOpen={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
      />
    </div>
  );
}

export function FirstRunCard({ error }: { error: string | null }) {
  const needsWorkspaceAccess = error === "Perminister denied this action.";

  return (
    <section aria-labelledby="first-run-title" className={styles.firstRunCard}>
      <div className={styles.firstRunIntro}>
        <div className={styles.firstRunLabel}>
          <span className={styles.firstRunIcon}>
            <Icon name="server" size={18} />
          </span>
          <span>GETTING STARTED</span>
        </div>
        <h2 id="first-run-title">
          {needsWorkspaceAccess
            ? "Grant your account access to this workspace."
            : "Connect your workspace to see your Postgres databases."}
        </h2>
        <p>
          {needsWorkspaceAccess
            ? "Your workspace is connected. Perminister needs to grant this account workspace access before Nanogres can show database health, storage, backups, and recent changes."
            : "Once the private management API is connected, this page will show database health, storage, backups, and recent changes."}
        </p>
        {needsWorkspaceAccess ? (
          <WorkspaceBootstrap />
        ) : (
          <a
            className={styles.setupLink}
            href="https://github.com/zakaihamilton/nanogres#connect-workspace"
            rel="noreferrer"
            target="_blank"
          >
            Open the setup guide <span aria-hidden="true">↗</span>
          </a>
        )}
        {error && !needsWorkspaceAccess ? (
          <details className={styles.connectionDetails}>
            <summary>Connection details</summary>
            <p>{error}</p>
          </details>
        ) : null}
      </div>
      <ol aria-label="Your first three steps" className={styles.firstRunSteps}>
        <li className={styles.firstRunStep}>
          <span className={styles.stepNumber}>01</span>
          <span>
            <strong>
              {needsWorkspaceAccess ? "Grant workspace access" : "Connect your server"}
            </strong>
            <small>
              {needsWorkspaceAccess
                ? "Initialize this workspace in Perminister."
                : "Set up the private HTTPS API."}
            </small>
          </span>
          <Icon name={needsWorkspaceAccess ? "shield" : "server"} size={16} />
        </li>
        <li className={styles.firstRunStep}>
          <span className={styles.stepNumber}>02</span>
          <span>
            <strong>Create a database</strong>
            <small>Give each project its own space.</small>
          </span>
          <Icon name="database" size={16} />
        </li>
        <li className={styles.firstRunStep}>
          <span className={styles.stepNumber}>03</span>
          <span>
            <strong>Save a backup copy</strong>
            <small>Download a dump for off-server recovery.</small>
          </span>
          <Icon name="backup" size={16} />
        </li>
      </ol>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}
