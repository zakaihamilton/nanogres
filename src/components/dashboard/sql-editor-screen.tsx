"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { CodeEditor } from "@/components/ui/code-editor";
import { Select } from "@/components/ui/select";
import { nanogresToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { apiRequest, useDatabases, Button, ErrorNotice } from "./live-shared";
import styles from "./sql-editor-screen.module.css";

type TabState = {
  id: string;
  title: string;
  query: string;
};

type QueryResult = {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  durationMs: number;
  commandTag?: string;
  truncated?: boolean;
};

const DEFAULT_TABS: TabState[] = [
  {
    id: "tab-1",
    title: "Query 1",
    query:
      "SELECT table_schema, table_name, table_type\nFROM information_schema.tables\nWHERE table_schema = 'public'\nORDER BY table_name;",
  },
  {
    id: "tab-2",
    title: "Activity",
    query:
      "SELECT pid, usename, datname, client_addr, state, query\nFROM pg_stat_activity\nWHERE state IS NOT NULL;",
  },
];

export function SqlEditorScreen() {
  const searchParams = useSearchParams();
  const initialDb = searchParams.get("db") || "";
  const initialQuery = searchParams.get("q");

  const { databases, loading: dbsLoading } = useDatabases();
  const [selectedDbChoice, setSelectedDb] = useState(initialDb);
  const selectedDb = databases.some((database) => database.name === selectedDbChoice)
    ? selectedDbChoice
    : initialDb
      ? ""
      : (databases[0]?.name ?? "");

  // Tabs state with localStorage
  const [tabs, setTabs] = useState<TabState[]>(() => {
    if (initialQuery) {
      return [
        {
          id: "tab-1",
          title: "Query 1",
          query: initialQuery,
        },
        ...DEFAULT_TABS.slice(1),
      ];
    }
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("nanogres_sql_tabs");
        if (saved) return JSON.parse(saved);
      } catch {
        // ignore
      }
    }
    return DEFAULT_TABS;
  });

  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]?.id || "tab-1");

  // Persist tabs
  useEffect(() => {
    try {
      localStorage.setItem("nanogres_sql_tabs", JSON.stringify(tabs));
    } catch {
      // ignore
    }
  }, [tabs]);

  const currentTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // Execution & guardrails
  const [readOnly, setReadOnly] = useState(false);
  const [defaultLimit, setDefaultLimit] = useState(true);
  const [timeoutSeconds, setTimeoutSeconds] = useState(15);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateCurrentQuery = (newQuery: string) => {
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, query: newQuery } : t)));
  };

  const handleAddTab = () => {
    const id = `tab-${Date.now()}`;
    const newTab: TabState = {
      id,
      title: `Query ${tabs.length + 1}`,
      query: "SELECT NOW();",
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const nextTabs = tabs.filter((t) => t.id !== id);
    setTabs(nextTabs);
    if (activeTabId === id) {
      setActiveTabId(nextTabs[0]?.id || "");
    }
  };

  const executeSql = useCallback(
    async (overrideSql?: string) => {
      if (!selectedDb) return;
      let sqlToRun = (overrideSql ?? currentTab?.query ?? "").trim();
      if (!sqlToRun) return;

      // Apply default limit guardrail if unbounded SELECT
      if (
        defaultLimit &&
        !overrideSql &&
        /^\s*SELECT\b/i.test(sqlToRun) &&
        !/\bLIMIT\b/i.test(sqlToRun)
      ) {
        const hasTrailingSemicolon = sqlToRun.endsWith(";");
        const query = hasTrailingSemicolon ? sqlToRun.slice(0, -1).trimEnd() : sqlToRun;
        sqlToRun = `${query}\nLIMIT 100${hasTrailingSemicolon ? ";" : ""}`;
      }

      setExecuting(true);
      setError(null);

      try {
        const res = await apiRequest<QueryResult>("/api/nanogres/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            database: selectedDb,
            sql: sqlToRun,
            readOnly,
            timeoutSeconds,
            maxRows: 500,
          }),
        });
        setResult(res);
        nanogresToast.success(`Executed in ${res.durationMs}ms (${res.rowCount} rows)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Query execution failed";
        setError(msg);
        nanogresToast.error(msg);
      } finally {
        setExecuting(false);
      }
    },
    [currentTab, defaultLimit, readOnly, timeoutSeconds, selectedDb],
  );

  const handleExplain = (analyze = false) => {
    if (!currentTab?.query.trim()) return;
    const prefix = analyze ? "EXPLAIN (ANALYZE, BUFFERS, VERBOSE)\n" : "EXPLAIN\n";
    void executeSql(prefix + currentTab.query);
  };

  // CSV export
  const exportCsv = () => {
    if (!result || !result.columns.length) return;
    const rows = [
      result.columns.map((col) => `"${col.replace(/"/g, '""')}"`).join(","),
      ...result.rows.map((row) =>
        row.map((cell) => (cell === null ? "" : `"${String(cell).replace(/"/g, '""')}"`)).join(","),
      ),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query_${selectedDb}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    nanogresToast.success("CSV export downloaded");
  };

  // JSON export
  const exportJson = () => {
    if (!result || !result.columns.length) return;
    const objects = result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
    const blob = new Blob([JSON.stringify(objects, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query_${selectedDb}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    nanogresToast.success("JSON export downloaded");
  };

  return (
    <div className={styles.screen}>
      <div className={styles.headerBar}>
        <div className={styles.titleArea}>
          <h1>SQL Editor</h1>
          <p>Execute queries, inspect results, and analyze plans on an organization database.</p>
        </div>
        <div className={styles.controlsBar}>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: "var(--ink-soft)",
            }}
          >
            Database:
            <Select
              align="end"
              aria-label="Select target database"
              className={styles.selectDb}
              disabled={dbsLoading}
              onChange={setSelectedDb}
              value={selectedDb}
            >
              {selectedDb && !databases.some((database) => database.name === selectedDb) ? (
                <option value="">No accessible database</option>
              ) : null}
              {!selectedDb ? (
                <option value="">
                  {initialDb ? "Requested database unavailable" : "Select an organization database"}
                </option>
              ) : null}
              {databases.map((db) => (
                <option key={db.name} value={db.name}>
                  {db.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      {/* Tabs */}
      <div className={styles.tabRow}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.scratchTab} ${tab.id === activeTabId ? styles.scratchTabActive : ""}`}
            onClick={() => setActiveTabId(tab.id)}
            type="button"
          >
            <span>{tab.title}</span>
            {tabs.length > 1 ? (
              <Tooltip label="Close tab">
                <span
                  className={styles.tabClose}
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleCloseTab(tab.id, e as unknown as React.MouseEvent);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  ×
                </span>
              </Tooltip>
            ) : null}
          </button>
        ))}
        <Tooltip label="New query tab">
          <button className={styles.addTabBtn} onClick={handleAddTab} type="button">
            + New Tab
          </button>
        </Tooltip>
      </div>

      {/* Code Editor */}
      <CodeEditor
        minHeight={220}
        onChange={updateCurrentQuery}
        onExecute={() => void executeSql()}
        placeholder="Type SQL query (e.g. SELECT * FROM users LIMIT 10)..."
        value={currentTab?.query || ""}
      />

      {/* Guardrails and action bar */}
      <div className={styles.guardrailsBar}>
        <div className={styles.guardrailsLeft}>
          <Tooltip label="Executes inside a read-only transaction">
            <label className={styles.guardrailToggle}>
              <input
                checked={readOnly}
                className={styles.guardrailCheckbox}
                onChange={(e) => setReadOnly(e.target.checked)}
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
                onChange={(e) => setDefaultLimit(e.target.checked)}
                type="checkbox"
              />
              Limit 100
            </label>
          </Tooltip>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--ink-soft)",
            }}
          >
            <label htmlFor="query-timeout">Timeout:</label>
            <Select
              className={styles.timeoutSelect}
              id="query-timeout"
              onChange={(value) => setTimeoutSeconds(Number(value))}
              value={String(timeoutSeconds)}
            >
              <option value="5">5s</option>
              <option value="15">15s</option>
              <option value="30">30s</option>
            </Select>
          </div>
        </div>

        <div className={styles.actionButtons}>
          <Button disabled={!selectedDb} onClick={() => handleExplain(false)} variant="secondary">
            Explain
          </Button>
          <Button disabled={!selectedDb} onClick={() => handleExplain(true)} variant="secondary">
            Explain Analyze
          </Button>
          <Button
            disabled={executing || !selectedDb}
            onClick={() => void executeSql()}
            variant="primary"
          >
            {executing ? "Executing..." : "Run Query ⌘↵"}
          </Button>
        </div>
      </div>

      {/* Inline error notice if execution failed */}
      <ErrorNotice error={error} />

      {/* Results Panel */}
      {result ? (
        <div className={styles.resultsPanel}>
          <div className={styles.resultsHeader}>
            <div className={styles.resultsMeta}>
              <span>
                Status: <strong>{result.commandTag || "COMPLETED"}</strong>
              </span>
              <span>·</span>
              <span>
                Duration: <span className={styles.durationBadge}>{result.durationMs}ms</span>
              </span>
              <span>·</span>
              <span>
                Rows: <strong>{result.rowCount}</strong>
              </span>
              {result.truncated ? (
                <span style={{ color: "var(--amber)", fontSize: 11 }}>
                  (Showing first 500 rows)
                </span>
              ) : null}
            </div>
            {result.columns.length ? (
              <div className={styles.exportButtons}>
                <button className={styles.exportBtn} onClick={exportCsv} type="button">
                  Download CSV
                </button>
                <button className={styles.exportBtn} onClick={exportJson} type="button">
                  Download JSON
                </button>
              </div>
            ) : null}
          </div>

          {!result.columns.length ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--ink-soft)" }}>
              Query executed successfully. (No tabular rows returned)
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.resultsTable}>
                <thead>
                  <tr>
                    {result.columns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx}>
                          {cell === null ? (
                            <span style={{ color: "var(--ink-muted)", fontStyle: "italic" }}>
                              null
                            </span>
                          ) : (
                            String(cell)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
