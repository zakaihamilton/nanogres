// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Tab panels are keyboard-focusable by the ARIA tabs pattern.
"use client";

import {
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog } from "panel-frame-ui";
import { Icon } from "./icons";
import { formatBytes } from "./storage-capacity";
import { ConnectionModal } from "@/components/ui/connection-modal";
import { nanogresToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import {
  type Database,
  apiRequest,
  useApiData,
  Button,
  Panel,
  Notice,
  Loading,
  Empty,
} from "./live-shared";
import styles from "./database-details.module.css";
import liveStyles from "./live-screens.module.css";

type Tab = "overview" | "schema" | "queries" | "backups";

function DatabaseTabPanel({
  tab,
  children,
}: {
  tab: "schema" | "queries" | "backups";
  children: ReactNode;
}) {
  return (
    <div
      aria-labelledby={`database-tab-${tab}`}
      id="database-panel"
      role="tabpanel"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
      tabIndex={0}
    >
      {children}
    </div>
  );
}
const tabOrder: Tab[] = ["overview", "schema", "queries", "backups"];

type ColumnMeta = {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  ordinalPosition: number;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
};

type IndexMeta = {
  name: string;
  definition: string;
  sizeBytes: number;
  isUnique: boolean;
  isPrimary: boolean;
};

type TableMeta = {
  name: string;
  kind: string;
  estimatedRows: number;
  totalSizeBytes: number;
  tableSizeBytes: number;
  indexSizeBytes: number;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
};

type SchemaMeta = {
  name: string;
  tables: TableMeta[];
};

type SchemaResponse = {
  schemas: SchemaMeta[];
};

type ActiveQuery = {
  pid: number;
  userName: string;
  database: string;
  clientAddress: string;
  applicationName: string;
  state: string;
  queryStart: string;
  durationSeconds: number;
  query: string;
};

export function DatabaseDetails({ databaseName }: { databaseName: string }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [connectModalOpen, setConnectModalOpen] = useState(false);

  // Queries state
  const [autoRefreshQueries, setAutoRefreshQueries] = useState(true);
  const queriesQuery = useApiData<{ queries: ActiveQuery[] }>(
    `/api/nanogres/databases/${encodeURIComponent(databaseName)}/queries`,
  );
  const activeQueries = queriesQuery.data?.queries ?? [];

  useEffect(() => {
    if (activeTab !== "queries" || !autoRefreshQueries) return;
    const timer = setInterval(() => {
      void queriesQuery.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [activeTab, autoRefreshQueries, queriesQuery]);

  // Schema state
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  // DDL Modal states
  const [createTableModal, setCreateTableModal] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [newTableCols, setNewTableCols] = useState(
    "id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), name TEXT NOT NULL",
  );
  const [isDdlSaving, setIsDdlSaving] = useState(false);
  const newTableNameInputRef = useRef<HTMLInputElement>(null);

  // Load database info from fleet overview
  const dbQuery = useApiData<{ databases: Database[] }>("/api/nanogres/databases");
  const db = dbQuery.data?.databases.find((item) => item.name === databaseName);

  // Load Schema
  const schemaQuery = useApiData<SchemaResponse>(
    `/api/nanogres/databases/${encodeURIComponent(databaseName)}/schema`,
  );
  const schemas = schemaQuery.data?.schemas ?? [];
  const publicTables = schemas.flatMap((s) => s.tables) ?? [];
  const currentTable = publicTables.find(
    (t) => t.name === (selectedTable || publicTables[0]?.name),
  );

  // Query kill / cancel
  const handleTerminateQuery = async (pid: number, signal: "cancel" | "terminate") => {
    try {
      await apiRequest(`/api/nanogres/activity/queries/${pid}/terminate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: signal }),
      });
      nanogresToast.success(`${signal.toUpperCase()} signal sent to pid ${pid}`);
      void queriesQuery.refresh();
    } catch (err) {
      nanogresToast.error(err instanceof Error ? err.message : "Failed to terminate query");
    }
  };

  // DDL: Create Table
  const handleCreateTable = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTableName.trim()) return;
    setIsDdlSaving(true);
    try {
      // Parse columns string into structured payload
      const cols = newTableCols.split(",").map((c) => {
        const parts = c.trim().split(/\s+/);
        const name = parts[0];
        const type = parts.slice(1).join(" ");
        return {
          name,
          type: type || "text",
          nullable: !type.toUpperCase().includes("NOT NULL"),
          primaryKey: type.toUpperCase().includes("PRIMARY KEY"),
        };
      });

      await apiRequest(`/api/nanogres/databases/${encodeURIComponent(databaseName)}/ddl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "create_table",
          name: newTableName.trim(),
          columns: cols,
        }),
      });
      nanogresToast.success(`Table “${newTableName}” created successfully`);
      setCreateTableModal(false);
      setNewTableName("");
      void schemaQuery.refresh();
    } catch (err) {
      nanogresToast.error(err instanceof Error ? err.message : "Failed to create table");
    } finally {
      setIsDdlSaving(false);
    }
  };

  // DDL: Maintenance (VACUUM / ANALYZE)
  const handleMaintenance = async (action: "vacuum" | "analyze" | "reindex", table?: string) => {
    try {
      await apiRequest(`/api/nanogres/databases/${encodeURIComponent(databaseName)}/ddl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "maintenance",
          action,
          table,
        }),
      });
      nanogresToast.success(`${action.toUpperCase()} executed successfully`);
      void schemaQuery.refresh();
    } catch (err) {
      nanogresToast.error(err instanceof Error ? err.message : "Maintenance operation failed");
    }
  };

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: Tab) {
    const currentIndex = tabOrder.indexOf(currentTab);
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabOrder.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + tabOrder.length) % tabOrder.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabOrder.length - 1;
    else return;

    event.preventDefault();
    const nextTab = tabOrder[nextIndex];
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  return (
    <div className={styles.databaseScreen}>
      <div className={styles.headerWrap}>
        <div>
          <div className={styles.dbEyebrow}>
            <span>DATABASE</span>
          </div>
          <div className={styles.titleArea}>
            <h1>
              {databaseName}
              {db?.systemDatabase ? <span className={styles.sysTag}>SYSTEM DATABASE</span> : null}
            </h1>
          </div>
        </div>
        <div className={liveStyles.actionGroup}>
          <Tooltip label={!db ? "Database is unavailable" : undefined}>
            <button
              className={liveStyles.actionSecondaryButton}
              disabled={!db}
              onClick={() => setConnectModalOpen(true)}
              type="button"
            >
              <Icon name="terminal" size={14} />
              Connect
            </button>
          </Tooltip>
          <Link
            className={liveStyles.actionSecondaryButton}
            href={`/sql?db=${encodeURIComponent(databaseName)}`}
          >
            <Icon name="sql" size={14} />
            SQL Console
          </Link>
        </div>
      </div>

      <div aria-label="Database sections" className={styles.tabsBar} role="tablist">
        {(
          [
            ["overview", "Overview & Connect"],
            ["schema", `Schema & Tables (${publicTables.length})`],
            ["queries", `Live Queries (${activeQueries.length})`],
            ["backups", "Database Backups"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            ref={(element) => {
              tabRefs.current[key] = element;
            }}
            id={`database-tab-${key}`}
            aria-selected={activeTab === key}
            aria-controls="database-panel"
            className={`${styles.tabBtn} ${activeTab === key ? styles.tabBtnActive : ""}`}
            onClick={() => setActiveTab(key)}
            onKeyDown={(event) => handleTabKeyDown(event, key)}
            role="tab"
            tabIndex={activeTab === key ? 0 : -1}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab 1: Overview */}
      {activeTab === "overview" ? (
        <div
          aria-labelledby="database-tab-overview"
          id="database-panel"
          role="tabpanel"
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
          tabIndex={0}
        >
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
              <strong>{publicTables.length}</strong>
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
              <Button onClick={() => void handleMaintenance("analyze")} variant="secondary">
                Run ANALYZE
              </Button>
              <Button onClick={() => void handleMaintenance("vacuum")} variant="secondary">
                Run VACUUM
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}

      {/* Tab 2: Schema & Tables */}
      {activeTab === "schema" ? (
        <DatabaseTabPanel tab="schema">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              Inspect tables, columns, indexes, and run DDL operations.
            </span>
            <Button
              onClick={() => setCreateTableModal(true)}
              variant="primary"
            >
              <Icon name="plus" size={14} /> Create Table
            </Button>
          </div>

          {schemaQuery.loading ? (
            <Loading label="Reading PostgreSQL catalog..." />
          ) : !publicTables.length ? (
            <Empty>No user tables found in this database. Click Create Table to add one.</Empty>
          ) : (
            <div className={styles.schemaBrowser}>
              <div className={styles.tableListPanel}>
                <div className={styles.tableListTitle}>
                  <span>Tables ({publicTables.length})</span>
                </div>
                <div className={styles.tableTree}>
                  {publicTables.map((tbl) => {
                    const isSelected = tbl.name === (currentTable?.name || publicTables[0]?.name);
                    return (
                      <button
                        key={tbl.name}
                        className={`${styles.tableItem} ${isSelected ? styles.tableItemActive : ""}`}
                        onClick={() => setSelectedTable(tbl.name)}
                        type="button"
                      >
                        <span>{tbl.name}</span>
                        <small style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                          {tbl.estimatedRows} rows
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>

              {currentTable ? (
                <div className={styles.tableDetailPanel}>
                  <div className={styles.detailHeader}>
                    <div>
                      <h2 className={styles.detailTitle}>{currentTable.name}</h2>
                      <div className={styles.statsStrip}>
                        <span>~{currentTable.estimatedRows} rows</span>
                        <span>·</span>
                        <span>Table size: {formatBytes(currentTable.tableSizeBytes)}</span>
                        <span>·</span>
                        <span>Index size: {formatBytes(currentTable.indexSizeBytes)}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Link
                        className={liveStyles.actionSecondaryButton}
                        href={`/sql?db=${encodeURIComponent(databaseName)}&q=SELECT * FROM ${encodeURIComponent(currentTable.name)} LIMIT 100;`}
                      >
                        Query Table →
                      </Link>
                      <Button
                        onClick={() => void handleMaintenance("vacuum", currentTable.name)}
                        variant="secondary"
                      >
                        Vacuum
                      </Button>
                    </div>
                  </div>

                  {/* Columns Table */}
                  <div>
                    <h3 style={{ fontSize: 13, marginBottom: 8, color: "var(--ink)" }}>
                      Columns ({currentTable.columns.length})
                    </h3>
                    <div className={liveStyles.tableWrap}>
                      <table>
                        <thead>
                          <tr>
                            <th>Column</th>
                            <th>Type</th>
                            <th>Nullable</th>
                            <th>Default</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentTable.columns.map((col) => (
                            <tr key={col.name}>
                              <td>
                                <strong>{col.name}</strong>
                                {col.isPrimaryKey ? (
                                  <span className={styles.pkBadge}>PK</span>
                                ) : null}
                                {col.isForeignKey ? (
                                  <span className={styles.fkBadge}>FK</span>
                                ) : null}
                              </td>
                              <td>
                                <code>{col.type}</code>
                              </td>
                              <td>{col.nullable ? "YES" : "NO"}</td>
                              <td>{col.defaultValue ? <code>{col.defaultValue}</code> : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Indexes Table */}
                  {currentTable.indexes?.length ? (
                    <div>
                      <h3 style={{ fontSize: 13, marginBottom: 8, color: "var(--ink)" }}>
                        Indexes ({currentTable.indexes.length})
                      </h3>
                      <div className={liveStyles.tableWrap}>
                        <table>
                          <thead>
                            <tr>
                              <th>Index Name</th>
                              <th>Size</th>
                              <th>Attributes</th>
                              <th>Definition</th>
                            </tr>
                          </thead>
                          <tbody>
                            {currentTable.indexes.map((idx) => (
                              <tr key={idx.name}>
                                <td>
                                  <strong>{idx.name}</strong>
                                </td>
                                <td>{formatBytes(idx.sizeBytes)}</td>
                                <td>{idx.isUnique ? "UNIQUE" : "STANDARD"}</td>
                                <td>
                                  <code style={{ fontSize: 11 }}>{idx.definition}</code>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </DatabaseTabPanel>
      ) : null}

      {/* Tab 3: Live Queries */}
      {activeTab === "queries" ? (
        <DatabaseTabPanel tab="queries">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                Active processes from <code>pg_stat_activity</code>
              </span>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  checked={autoRefreshQueries}
                  onChange={(e) => setAutoRefreshQueries(e.target.checked)}
                  type="checkbox"
                />
                Auto-refresh (3s)
              </label>
            </div>
            <Button onClick={() => void queriesQuery.refresh()} variant="secondary">
              Refresh now
            </Button>
          </div>

          {!activeQueries.length ? (
            <Empty>No active queries currently running on database “{databaseName}”.</Empty>
          ) : (
            <div className={liveStyles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>PID</th>
                    <th>User</th>
                    <th>Client</th>
                    <th>State</th>
                    <th>Duration</th>
                    <th>Query</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {activeQueries.map((q) => {
                    let durColor = "var(--green)";
                    if (q.durationSeconds > 10) durColor = "var(--red)";
                    else if (q.durationSeconds > 2) durColor = "var(--amber)";

                    return (
                      <tr key={q.pid}>
                        <td>
                          <code>{q.pid}</code>
                        </td>
                        <td>{q.userName}</td>
                        <td>{q.clientAddress}</td>
                        <td>
                          <span
                            style={{
                              fontSize: 11,
                              padding: "2px 6px",
                              borderRadius: 4,
                              background: "var(--surface-muted)",
                            }}
                          >
                            {q.state}
                          </span>
                        </td>
                        <td style={{ color: durColor, fontWeight: 600 }}>{q.durationSeconds}s</td>
                        <td
                          style={{
                            maxWidth: 300,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <code>{q.query}</code>
                        </td>
                        <td>
                          <div style={{ display: "inline-flex", gap: 6 }}>
                            <Tooltip label="Cancel current query">
                              <button
                                className={liveStyles.rowAction}
                                onClick={() => void handleTerminateQuery(q.pid, "cancel")}
                                style={{ color: "var(--amber)" }}
                                type="button"
                              >
                                Cancel
                              </button>
                            </Tooltip>
                            <Tooltip label="Terminate backend connection">
                              <button
                                className={liveStyles.rowAction}
                                onClick={() => void handleTerminateQuery(q.pid, "terminate")}
                                style={{ color: "var(--red)" }}
                                type="button"
                              >
                                Kill
                              </button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DatabaseTabPanel>
      ) : null}

      {/* Tab 4: Backups */}
      {activeTab === "backups" ? (
        <DatabaseTabPanel tab="backups">
          <Notice tone="info">
            Backups specific to database “{databaseName}”. You can create a new dump or browse all
            snapshots in the main Backups tab.
          </Notice>
          <div style={{ display: "flex", gap: 10 }}>
            <Link
              className={liveStyles.primaryButton}
              href={`/backups/new?db=${encodeURIComponent(databaseName)}`}
            >
              Create Backup for {databaseName}
            </Link>
            <Link className={liveStyles.actionSecondaryButton} href="/backups">
              Go to Full Backups Manager →
            </Link>
          </div>
        </DatabaseTabPanel>
      ) : null}

      {/* Create Table Modal Dialog */}
      {createTableModal ? (
        <Dialog
          className={styles.modalContainer}
          description="Define a name and columns for the new table."
          initialFocusRef={newTableNameInputRef}
          onOpenChange={setCreateTableModal}
          open
          title={`Create Table in “${databaseName}”`}
        >
            <form onSubmit={handleCreateTable}>
              <div className={styles.formField} style={{ marginBottom: 12 }}>
                <label htmlFor="new-tbl-name">Table name</label>
                <input
                  ref={newTableNameInputRef}
                  id="new-tbl-name"
                  onChange={(e) => setNewTableName(e.target.value)}
                  placeholder="e.g. users, orders, posts"
                  required
                  value={newTableName}
                />
              </div>
              <div className={styles.formField} style={{ marginBottom: 16 }}>
                <label htmlFor="new-tbl-cols">Columns definition (comma-separated)</label>
                <input
                  id="new-tbl-cols"
                  onChange={(e) => setNewTableCols(e.target.value)}
                  placeholder="id SERIAL PRIMARY KEY, name TEXT NOT NULL"
                  required
                  value={newTableCols}
                />
              </div>
              <div className={styles.dialogButtons}>
                <Button onClick={() => setCreateTableModal(false)} variant="secondary">
                  Cancel
                </Button>
                <Button disabled={isDdlSaving} type="submit" variant="primary">
                  {isDdlSaving ? "Creating..." : "Create Table"}
                </Button>
              </div>
            </form>
        </Dialog>
      ) : null}

      <ConnectionModal
        database={db?.connectionName ?? ""}
        isOpen={connectModalOpen && Boolean(db)}
        onClose={() => setConnectModalOpen(false)}
      />
    </div>
  );
}
