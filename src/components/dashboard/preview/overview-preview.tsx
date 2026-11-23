import { Icon } from "../icons";
import { FirstRunCard } from "../live-screens";
import { StorageCapacity } from "../storage-capacity";
import overviewStyles from "./overview-preview.module.css";
import {
  ActivityList,
  ApiNotice,
  DatabaseTable,
  EmptyState,
  MetricCard,
  Panel,
  ScreenHeading,
} from "./primitives";
import styles from "./primitives.module.css";
import { databasesForScenario, diskForScenario, type PreviewScenario } from "./scenarios";

export function OverviewScreen({
  onPreviewNavigate,
  previewNotice,
  previewScenario = "healthy",
  readOnly = false,
}: {
  onPreviewNavigate?: (screen: string) => void;
  previewNotice?: string | null;
  previewScenario?: PreviewScenario;
  readOnly?: boolean;
}) {
  const connected = previewScenario !== "disconnected-server";
  const databases = databasesForScenario(previewScenario);
  const managedDatabaseCount = databases.filter((database) => !database.systemDatabase).length;
  const protectedDatabaseCount = databases.filter((database) => database.systemDatabase).length;
  const disk = diskForScenario(previewScenario);
  const backupValue =
    previewScenario === "backups-failed"
      ? "Failed"
      : previewScenario === "backups-unconfigured"
        ? "None"
        : previewScenario === "backups-stale"
          ? "4 days"
          : "Today";

  return (
    <div className={styles.screen}>
      <ScreenHeading
        action={readOnly || !connected ? undefined : "Create a database"}
        description="Manage the databases, access, and recovery assigned to your organization."
        eyebrow="ORGANIZATION DATABASES"
        title="Your Postgres, in one place."
        onAction={readOnly || !connected ? undefined : () => onPreviewNavigate?.("databases")}
      />
      {!connected ? <ApiNotice /> : null}
      {previewNotice ? (
        <div className={styles.previewNotice} role="status">
          {previewNotice}
        </div>
      ) : null}
      <div className={overviewStyles.metrics}>
        <MetricCard
          detail={
            !connected
              ? "Waiting for system connection"
              : `${managedDatabaseCount} managed · ${protectedDatabaseCount} protected system databases`
          }
          icon="database"
          label="Managed databases"
          value={connected ? String(managedDatabaseCount) : "—"}
        />
        <MetricCard
          detail={!connected ? "Waiting for system connection" : "Across active databases"}
          icon="activity"
          label="Active connections"
          tone="blue"
          value={!connected ? "—" : previewScenario === "connection-saturation" ? "147" : "11"}
        />
        <MetricCard
          detail={
            !connected
              ? "No backup schedule yet"
              : previewScenario === "backups-failed"
                ? "Most recent attempt failed"
                : previewScenario === "backups-unconfigured"
                  ? "No backup schedule yet"
                  : previewScenario === "backups-stale"
                    ? "Last completed 4 days ago"
                    : "Most recent: today, 09:15"
          }
          icon="backup"
          label="Latest backup"
          tone="green"
          value={connected ? backupValue : "—"}
        />
        <MetricCard
          detail="Organization database permissions"
          icon="access"
          label="Access grants"
          tone="amber"
          value={connected ? "2" : "—"}
        />
      </div>

      <div className={overviewStyles.overviewGrid}>
        <Panel
          detail={
            connected
              ? `${databases.length} total · ${managedDatabaseCount} managed · ${protectedDatabaseCount} protected system · refreshed just now`
              : "Live inventory will appear after connection"
          }
          title="Databases"
        >
          {connected && databases.length ? (
            <DatabaseTable rows={databases} onOpen={() => onPreviewNavigate?.("databases")} />
          ) : connected ? (
            <EmptyState
              description="Create a database to begin using this Postgres server."
              title="No databases yet"
            />
          ) : (
            <EmptyState
              description="Connect the VPS server to see database size, owners, and connection counts."
              title="No live inventory yet"
            />
          )}
        </Panel>

        <Panel detail="System health and connection status" title="System health">
          <div className={overviewStyles.healthCard}>
            <div className={overviewStyles.healthStatus}>
              <span className={`${overviewStyles.healthOrb} ${overviewStyles.healthOrbGood}`}>
                <Icon name="check" size={18} />
              </span>
              <span>
                <strong>{connected ? "All systems healthy" : "Waiting for first check"}</strong>
                <small>
                  {connected
                    ? "PostgreSQL 17 · running"
                    : "System health will load from the VPS server"}
                </small>
              </span>
            </div>
            <div className={overviewStyles.healthRows}>
              <div>
                <span>API endpoint</span>
                <strong>{connected ? "Connected" : "Not configured"}</strong>
              </div>
              <div>
                <span>Postgres</span>
                <strong>{connected ? "Healthy" : "Pending"}</strong>
              </div>
              <div>
                <span>Last checked</span>
                <strong>{connected ? "Just now" : "—"}</strong>
              </div>
              <div>
                <span>Off-site backup</span>
                <strong>
                  {!connected
                    ? "—"
                    : previewScenario === "backups-failed"
                      ? "Failed"
                      : previewScenario === "backups-unconfigured"
                        ? "Not configured"
                        : previewScenario === "backups-stale"
                          ? "Overdue"
                          : "Verified today"}
                </strong>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        detail="Current VPS disk usage and estimated database growth room"
        title="Storage capacity"
      >
        {connected ? (
          <StorageCapacity databases={databases} disk={disk} growthPercent={25} />
        ) : (
          <EmptyState
            description="Storage usage appears after the server connection is available."
            title="Storage status unavailable"
          />
        )}
      </Panel>

      <div className={overviewStyles.lowerGrid}>
        <Panel detail="Recent changes across this organization" title="Recent activity">
          <ActivityList compact />
        </Panel>
        <section className={overviewStyles.tipCard}>
          <span className={overviewStyles.tipIcon}>
            <Icon name="shield" size={19} />
          </span>
          <div>
            <p className={`${styles.eyebrow} ${overviewStyles.tipEyebrow}`}>SECURE BY DEFAULT</p>
            <h2>Your database stays private.</h2>
            <p>
              Nanogres connects securely from the backend server. Postgres is never opened to the
              browser.
            </p>
          </div>
          <span className={overviewStyles.tipDecoration} aria-hidden="true">
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
        eyebrow="ORGANIZATION DATABASES"
        title="Your Postgres, in one place."
      />
      <FirstRunCard error={null} />
    </div>
  );
}
