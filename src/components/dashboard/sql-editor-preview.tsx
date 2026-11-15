"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { CodeEditor } from "@/components/ui/code-editor";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { Button, ErrorNotice } from "./live-shared";
import type { PreviewScenario } from "./screens";
import styles from "./sql-editor-screen.module.css";

type PreviewTab = { id: string; title: string; query: string };
type PreviewQueryResult = {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  durationMs: number;
  commandTag: string;
};

const defaultQuery =
  "SELECT table_schema, table_name, table_type\nFROM information_schema.tables\nWHERE table_schema = 'public'\nORDER BY table_name;";
const activityQuery =
  "SELECT pid, usename, datname, state, query\nFROM pg_stat_activity\nWHERE state IS NOT NULL;";

const exampleResult: PreviewQueryResult = {
  columns: ["table_schema", "table_name", "table_type"],
  rows: [
    ["public", "customers", "BASE TABLE"],
    ["public", "events", "PARTITIONED TABLE"],
    ["public", "invoices", "BASE TABLE"],
    ["public", "subscriptions", "BASE TABLE"],
  ],
  rowCount: 4,
  durationMs: 12,
  commandTag: "SELECT 4",
};

const wideResult: PreviewQueryResult = {
  columns: [
    "table_schema",
    "table_name",
    "estimated_rows",
    "total_size",
    "index_size",
    "last_analyzed",
    "replication_status",
  ],
  rows: [
    ["public", "customer_event_archive", 1_284_200, "842 MB", "218 MB", "2 min ago", "synced"],
    ["public", "invoice_line_items", 342_910, "196 MB", "72 MB", "14 min ago", "synced"],
    ["public", "subscription_history", 89_440, "64 MB", "21 MB", "1 hour ago", "pending"],
  ],
  rowCount: 3,
  durationMs: 24,
  commandTag: "SELECT 3",
};

const emptyResult: PreviewQueryResult = {
  columns: ["table_schema", "table_name", "table_type"],
  rows: [],
  rowCount: 0,
  durationMs: 8,
  commandTag: "SELECT 0",
};

function resultForScenario(scenario: PreviewScenario): PreviewQueryResult {
  if (scenario === "sql-wide-results") return wideResult;
  if (scenario === "sql-empty-results") return emptyResult;
  return exampleResult;
}

function errorForScenario(scenario: PreviewScenario): string | null {
  if (scenario === "sql-error") return 'relation "public.missing_table" does not exist';
  if (scenario === "sql-no-database") return "No accessible database is available in this preview.";
  if (scenario === "disconnected-server") return "The PostgreSQL server is not connected in this preview.";
  if (scenario === "empty-cluster") return "This cluster has no organization databases yet.";
  return null;
}

export function SqlEditorPreview({ previewScenario }: { previewScenario: PreviewScenario }) {
  const noDatabase =
    previewScenario === "sql-no-database" ||
    previewScenario === "disconnected-server" ||
    previewScenario === "empty-cluster";
  const databases = noDatabase ? [] : ["app_main", "event_store", "sandbox"];
  const [selectedDatabase, setSelectedDatabase] = useState("app_main");
  const [tabs, setTabs] = useState<PreviewTab[]>([
    { id: "query", title: "Query 1", query: defaultQuery },
    { id: "activity", title: "Activity", query: activityQuery },
  ]);
  const [activeTabId, setActiveTabId] = useState("query");
  const [readOnly, setReadOnly] = useState(true);
  const [defaultLimit, setDefaultLimit] = useState(true);
  const [timeoutSeconds, setTimeoutSeconds] = useState(15);
  const [executing, setExecuting] = useState(false);
  const executionTimer = useRef<number | null>(null);
  const [result, setResult] = useState<PreviewQueryResult | null>(() =>
    noDatabase || previewScenario === "sql-error" ? null : resultForScenario(previewScenario),
  );
  const [error, setError] = useState<string | null>(() => errorForScenario(previewScenario));
  const currentTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const selectedDb = databases.includes(selectedDatabase) ? selectedDatabase : (databases[0] ?? "");

  useEffect(() => {
    window.clearTimeout(executionTimer.current ?? undefined);
    executionTimer.current = null;
    setExecuting(false);
    setResult(noDatabase || previewScenario === "sql-error" ? null : resultForScenario(previewScenario));
    setError(errorForScenario(previewScenario));
    return () => window.clearTimeout(executionTimer.current ?? undefined);
  }, [noDatabase, previewScenario]);

  function updateCurrentQuery(query: string) {
    setTabs((previous) =>
      previous.map((tab) => (tab.id === activeTabId ? { ...tab, query } : tab)),
    );
  }

  function runSyntheticQuery(query = currentTab?.query ?? "") {
    if (!selectedDb || !query.trim()) return;
    setExecuting(true);
    window.clearTimeout(executionTimer.current ?? undefined);
    executionTimer.current = window.setTimeout(() => {
      setError(errorForScenario(previewScenario));
      setResult(
        errorForScenario(previewScenario) || noDatabase
          ? null
          : resultForScenario(previewScenario),
      );
      setExecuting(false);
    }, 180);
  }

  function addTab() {
    const id = `preview-${Date.now()}`;
    setTabs((previous) => [
      ...previous,
      { id, title: `Query ${previous.length + 1}`, query: "SELECT NOW();" },
    ]);
    setActiveTabId(id);
  }

  function focusTab(index: number) {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    setActiveTabId(tab.id);
    document.getElementById(`sql-preview-tab-${tab.id}`)?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusTab(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusTab(tabs.length - 1);
    }
  }

  return (
    <div className={styles.screen}>
      <div className={styles.headerBar}>
        <div className={styles.titleArea}>
          <h1>SQL Editor</h1>
          <p>
            Execute queries, inspect results, and analyze plans. This preview uses synthetic data;
            queries are never sent to a database.
          </p>
        </div>
        <div className={styles.controlsBar}>
          <label className={styles.previewDatabaseLabel}>
            Database:
            <Select
              align="end"
              aria-label="Select target database"
              className={styles.selectDb}
              disabled={!databases.length}
              onChange={setSelectedDatabase}
              value={selectedDb}
            >
              {databases.length ? (
                databases.map((database) => (
                  <option key={database} value={database}>
                    {database}
                  </option>
                ))
              ) : (
                <option value="">No accessible database</option>
              )}
            </Select>
          </label>
        </div>
      </div>

      <div className={styles.tabRow}>
        <div aria-label="SQL query tabs" className={styles.previewTabList} role="tablist">
          {tabs.map((tab, index) => (
            <button
              aria-controls="sql-preview-editor-panel"
              aria-selected={tab.id === activeTabId}
              className={`${styles.scratchTab} ${tab.id === activeTabId ? styles.scratchTabActive : ""}`}
              id={`sql-preview-tab-${tab.id}`}
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              role="tab"
              tabIndex={tab.id === activeTabId ? 0 : -1}
              type="button"
            >
              {tab.title}
            </button>
          ))}
        </div>
        <Tooltip label="New query tab">
          <button className={styles.addTabBtn} onClick={addTab} type="button">
            + New Tab
          </button>
        </Tooltip>
      </div>

      <div
        aria-labelledby={`sql-preview-tab-${activeTabId}`}
        className={styles.previewTabPanel}
        id="sql-preview-editor-panel"
        role="tabpanel"
      >
        <CodeEditor
          minHeight={220}
          onChange={updateCurrentQuery}
          onExecute={() => runSyntheticQuery()}
          placeholder="Type SQL query (e.g. SELECT * FROM users LIMIT 10)..."
          value={currentTab?.query ?? ""}
        />
      </div>

      <div className={styles.guardrailsBar}>
        <div className={styles.guardrailsLeft}>
          <Tooltip label="Executes inside a read-only transaction">
            <label className={styles.guardrailToggle}>
              <input
                checked={readOnly}
                className={styles.guardrailCheckbox}
                onChange={(event) => setReadOnly(event.target.checked)}
                type="checkbox"
              />
              Read-Only Safety
            </label>
          </Tooltip>
          <Tooltip label="Appends LIMIT 100 to unbounded SELECT queries">
            <label className={styles.guardrailToggle}>
              <input
                checked={defaultLimit}
                className={styles.guardrailCheckbox}
                onChange={(event) => setDefaultLimit(event.target.checked)}
                type="checkbox"
              />
              Limit 100
            </label>
          </Tooltip>
          <label className={styles.previewTimeout}>
            Timeout:
            <Select
              className={styles.timeoutSelect}
              onChange={(value) => setTimeoutSeconds(Number(value))}
              value={String(timeoutSeconds)}
            >
              <option value="5">5s</option>
              <option value="15">15s</option>
              <option value="30">30s</option>
            </Select>
          </label>
        </div>
        <div className={styles.actionButtons}>
          <Button
            disabled={!selectedDb || executing}
            onClick={() => runSyntheticQuery(`EXPLAIN\n${currentTab?.query ?? ""}`)}
            variant="secondary"
          >
            Explain
          </Button>
          <Button
            disabled={!selectedDb || executing}
            onClick={() => runSyntheticQuery(`EXPLAIN (ANALYZE, BUFFERS)\n${currentTab?.query ?? ""}`)}
            variant="secondary"
          >
            Explain Analyze
          </Button>
          <Button
            disabled={executing || !selectedDb}
            onClick={() => runSyntheticQuery()}
            variant="primary"
          >
            {executing ? "Running preview…" : "Run Query ⌘↵"}
          </Button>
        </div>
      </div>

      <ErrorNotice error={error} />

      {result ? (
        <div className={styles.resultsPanel}>
          <div className={styles.resultsHeader}>
            <div className={styles.resultsMeta}>
              <span>
                Status: <strong>{result.commandTag}</strong>
              </span>
              <span>·</span>
              <span>
                Duration: <span className={styles.durationBadge}>{result.durationMs}ms</span>
              </span>
              <span>·</span>
              <span>
                Rows: <strong>{result.rowCount}</strong>
              </span>
            </div>
            {result.columns.length ? (
              <div className={styles.exportButtons}>
                <button className={styles.exportBtn} disabled type="button">
                  Download CSV
                </button>
                <button className={styles.exportBtn} disabled type="button">
                  Download JSON
                </button>
              </div>
            ) : null}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.resultsTable}>
              <thead>
                <tr>
                  {result.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.length ? (
                  result.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, columnIndex) => (
                        <td key={columnIndex}>{cell === null ? "null" : String(cell)}</td>
                      ))}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={result.columns.length}>No rows returned.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
