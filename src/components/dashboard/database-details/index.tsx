"use client";

import Link from "next/link";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { ConnectionModal } from "@/components/ui/connection-modal";
import { nanogresToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import styles from "../database-details.module.css";
import { Icon } from "../icons";
import { apiRequest, type Database, useApiData } from "../live-api";
import { Notice } from "../live-primitives";
import liveStyles from "../live-primitives.module.css";
import { CreateTableDialog } from "./create-table-dialog";
import { ExtensionsTab } from "./extensions-tab";
import { OverviewTab } from "./overview-tab";
import { QueriesTab } from "./queries-tab";
import { SchemaTab } from "./schema-tab";
import { DatabaseTabPanel } from "./tab-panel";
import { type ActiveQuery, type SchemaResponse, type Tab, tabOrder } from "./types";

export function DatabaseDetails({ databaseName }: { databaseName: string }) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [createTableModal, setCreateTableModal] = useState(false);
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

  const dbQuery = useApiData<{ databases: Database[] }>("/api/nanogres/databases");
  const db = dbQuery.data?.databases.find((item) => item.name === databaseName);

  const schemaQuery = useApiData<SchemaResponse>(
    `/api/nanogres/databases/${encodeURIComponent(databaseName)}/schema`,
  );
  const schemas = schemaQuery.data?.schemas ?? [];
  const publicTables = schemas.flatMap((schema) => schema.tables) ?? [];

  async function handleMaintenance(action: "vacuum" | "analyze" | "reindex", table?: string) {
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
  }

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
            ["extensions", "Extensions"],
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

      {activeTab === "overview" ? (
        <OverviewTab
          databaseName={databaseName}
          db={db}
          onMaintenance={handleMaintenance}
          tableCount={publicTables.length}
        />
      ) : null}

      {activeTab === "schema" ? (
        <SchemaTab
          databaseName={databaseName}
          loading={schemaQuery.loading}
          onMaintenance={handleMaintenance}
          onOpenCreateTable={() => setCreateTableModal(true)}
          tables={publicTables}
        />
      ) : null}

      {activeTab === "queries" ? (
        <QueriesTab
          activeQueries={activeQueries}
          autoRefreshQueries={autoRefreshQueries}
          databaseName={databaseName}
          onAutoRefreshChange={setAutoRefreshQueries}
          onRefresh={queriesQuery.refresh}
        />
      ) : null}

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

      {activeTab === "extensions" ? <ExtensionsTab databaseName={databaseName} /> : null}

      <CreateTableDialog
        databaseName={databaseName}
        onCreated={schemaQuery.refresh}
        onOpenChange={setCreateTableModal}
        open={createTableModal}
      />

      <ConnectionModal
        database={db?.connectionName ?? ""}
        isOpen={connectModalOpen && Boolean(db)}
        onClose={() => setConnectModalOpen(false)}
      />
    </div>
  );
}
