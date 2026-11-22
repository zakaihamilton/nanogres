"use client";

import { nanogresToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { apiRequest } from "../live-api";
import { Button, Empty } from "../live-primitives";
import liveStyles from "../live-primitives.module.css";
import { DatabaseTabPanel } from "./tab-panel";
import type { ActiveQuery } from "./types";

export function QueriesTab({
  databaseName,
  activeQueries,
  autoRefreshQueries,
  onAutoRefreshChange,
  onRefresh,
}: {
  databaseName: string;
  activeQueries: ActiveQuery[];
  autoRefreshQueries: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  async function handleTerminateQuery(pid: number, signal: "cancel" | "terminate") {
    try {
      await apiRequest(`/api/nanogres/activity/queries/${pid}/terminate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: signal }),
      });
      nanogresToast.success(`${signal.toUpperCase()} signal sent to pid ${pid}`);
      void onRefresh();
    } catch (err) {
      nanogresToast.error(err instanceof Error ? err.message : "Failed to terminate query");
    }
  }

  return (
    <DatabaseTabPanel tab="queries">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            Active processes from <code>pg_stat_activity</code>
          </span>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input
              checked={autoRefreshQueries}
              onChange={(event) => onAutoRefreshChange(event.target.checked)}
              type="checkbox"
            />
            Auto-refresh (3s)
          </label>
        </div>
        <Button onClick={() => void onRefresh()} variant="secondary">
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
              {activeQueries.map((query) => {
                let durationColor = "var(--green)";
                if (query.durationSeconds > 10) durationColor = "var(--red)";
                else if (query.durationSeconds > 2) durationColor = "var(--amber)";

                return (
                  <tr key={query.pid}>
                    <td>
                      <code>{query.pid}</code>
                    </td>
                    <td>{query.userName}</td>
                    <td>{query.clientAddress}</td>
                    <td>
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "var(--surface-muted)",
                        }}
                      >
                        {query.state}
                      </span>
                    </td>
                    <td style={{ color: durationColor, fontWeight: 600 }}>
                      {query.durationSeconds}s
                    </td>
                    <td
                      style={{
                        maxWidth: 300,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <code>{query.query}</code>
                    </td>
                    <td>
                      <div style={{ display: "inline-flex", gap: 6 }}>
                        <Tooltip label="Cancel current query">
                          <button
                            className={liveStyles.rowAction}
                            onClick={() => void handleTerminateQuery(query.pid, "cancel")}
                            style={{ color: "var(--amber)" }}
                            type="button"
                          >
                            Cancel
                          </button>
                        </Tooltip>
                        <Tooltip label="Terminate backend connection">
                          <button
                            className={liveStyles.rowAction}
                            onClick={() => void handleTerminateQuery(query.pid, "terminate")}
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
  );
}
