"use client";

import { useRouter } from "next/navigation";
import styles from "../database-details.module.css";
import type { Database } from "../live-api";
import { Button, Panel } from "../live-primitives";
import liveStyles from "../live-primitives.module.css";
import { formatBytes } from "../storage-capacity";
import { DatabaseTabPanel } from "./tab-panel";

export function OverviewTab({
  databaseName,
  db,
  tableCount,
  onMaintenance,
}: {
  databaseName: string;
  db: Database | undefined;
  tableCount: number;
  onMaintenance: (action: "vacuum" | "analyze" | "reindex") => Promise<void>;
}) {
  const router = useRouter();

  return (
    <DatabaseTabPanel gap={16} tab="overview">
      <div className={liveStyles.metrics}>
        <div className={liveStyles.metric}>
          <span>Storage Size</span>
          <strong>{db ? formatBytes(db.sizeBytes) : "—"}</strong>
          <small>Disk space occupied by primary files</small>
        </div>
        <div className={liveStyles.metric}>
          <span>Connections</span>
          <strong>{db ? `${db.connections} / ${db.maxConnections}` : "—"}</strong>
          <small>Active connections to this database</small>
        </div>
        <div className={liveStyles.metric}>
          <span>Tables</span>
          <strong>{tableCount}</strong>
          <small>In accessible schemas</small>
        </div>
        <div className={liveStyles.metric}>
          <span>Owner</span>
          <strong>{db?.owner || "—"}</strong>
          <small>Default authorization role</small>
        </div>
      </div>

      <Panel title="Quick Query & Actions" detail="Execute operations on this database">
        <div className={styles.quickActions}>
          <Button
            onClick={() => router.push(`/sql?db=${encodeURIComponent(databaseName)}`)}
            variant="primary"
          >
            Open in SQL Editor →
          </Button>
          <Button onClick={() => void onMaintenance("analyze")} variant="secondary">
            Run ANALYZE
          </Button>
          <Button onClick={() => void onMaintenance("vacuum")} variant="secondary">
            Run VACUUM
          </Button>
        </div>
      </Panel>
    </DatabaseTabPanel>
  );
}
