"use client";

import { useState, useMemo } from "react";
import { Icon } from "./icons";
import { useTelemetryStream } from "@/lib/use-stream";
import { nanogresToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import {
  type ActivityEvent,
  useApiData,
  PageHeader,
  Button,
  Panel,
  ErrorNotice,
  ActivityList,
} from "./live-shared";
import styles from "./live-screens.module.css";

export function LiveActivityScreen() {
  const { data, error, loading, refresh } = useApiData<{ events: ActivityEvent[] }>(
    "/api/nanogres/activity",
  );
  const { isLive } = useTelemetryStream(Boolean(data));

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");

  const rawEvents = data?.events;

  const filteredEvents = useMemo(() => {
    if (!rawEvents) return [];
    return rawEvents.filter((ev) => {
      if (filterType !== "all") {
        if (!ev.action.toLowerCase().startsWith(filterType)) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        return (
          ev.action.toLowerCase().includes(q) ||
          ev.detail.toLowerCase().includes(q) ||
          (ev.actor && ev.actor.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [rawEvents, filterType, search]);

  const exportActivity = () => {
    if (!filteredEvents.length) return;
    const blob = new Blob([JSON.stringify(filteredEvents, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nanogres_activity_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    nanogresToast.success("Activity log downloaded");
  };

  return (
    <div className={styles.screen}>
      <PageHeader
        action={
          <div className={styles.actionGroup}>
            <Tooltip label={isLive ? "Live real-time stream active" : "Polling mode"}>
              <span className={`${styles.livePill} ${isLive ? "" : styles.livePillOffline}`}>
                <span className={styles.pulsingDot} />
                {isLive ? "LIVE FEED" : "POLLING"}
              </span>
            </Tooltip>
            <button className={styles.actionSecondaryButton} onClick={exportActivity} type="button">
              Export JSON
            </button>
            <Button onClick={() => void refresh()} variant="secondary">
              Refresh
            </Button>
          </div>
        }
        description="A real-time server-side record of database, role, query, and backup operations."
        eyebrow="AUDIT TRAIL"
        title="Activity"
      />
      <ErrorNotice error={error} onRetry={() => void refresh()} />

      <div className={styles.tableToolbar}>
        <div className={styles.searchInputWrap}>
          <Icon name="search" size={14} />
          <input
            aria-label="Search events"
            className={styles.searchInput}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by action, detail, or actor..."
            value={search}
          />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            ["all", "All Events"],
            ["database", "Databases"],
            ["role", "Roles"],
            ["backup", "Backups"],
            ["query", "Queries"],
          ].map(([val, label]) => (
            <button
              key={val}
              className={`${styles.filterChip} ${filterType === val ? styles.filterChipActive : ""}`}
              onClick={() => setFilterType(val)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Panel
        title="Audit events"
        detail={`${filteredEvents.length} event${filteredEvents.length === 1 ? "" : "s"} found`}
      >
        <ActivityList error={error} events={filteredEvents} loading={loading && !data} />
      </Panel>
    </div>
  );
}
