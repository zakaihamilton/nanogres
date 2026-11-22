"use client";

import { useState } from "react";
import { Icon } from "@/components/dashboard/icons";
import styles from "../welcome.module.css";

const SAMPLE_CONNECTION_STRING = "postgresql://app_user:••••••••@127.0.0.1:5432/app_production";

const SHOWCASE_SUMMARY = [
  { label: "Active Databases", value: "3", positive: false },
  { label: "VPS Storage", value: "1.26 GB", positive: false },
  { label: "Active Connections", value: "24", positive: false },
  { label: "Daily Backups", value: "Healthy", positive: true },
] as const;

const SHOWCASE_DATABASES = [
  { name: "app_production", size: "42 MB", connections: "14 active", status: "Healthy" },
  { name: "analytics_warehouse", size: "1.20 GB", connections: "8 active", status: "Healthy" },
  { name: "auth_service", size: "18 MB", connections: "2 active", status: "Healthy" },
] as const;

const SHOWCASE_QUERY_ROWS = [
  { id: "usr_948a", fullName: "Elena Vance", role: "Administrator", status: "Active" },
  { id: "usr_381c", fullName: "Marcus Brody", role: "Developer", status: "Active" },
  { id: "usr_721f", fullName: "Aria Stark", role: "Engineer", status: "Active" },
] as const;

const DRIVER_PILLS = [
  "Node.js (pg)",
  "Python (psycopg)",
  "Go (pgx)",
  "psql CLI",
  ".env format",
] as const;

export function ProductShowcase() {
  const [activeTab, setActiveTab] = useState<"databases" | "query" | "connect">("databases");
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const copySampleConnection = async () => {
    try {
      await navigator.clipboard.writeText(SAMPLE_CONNECTION_STRING);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className={styles.showcase}>
      <div className={styles.showcaseHeader}>
        <div className={styles.windowDots}>
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className={styles.dot} />
        </div>
        <div className={styles.showcaseTitle}>
          <Icon name="database" size={14} />
          <span>Nanogres Studio · PostgreSQL 17</span>
        </div>
        <div className={styles.showcaseStatus}>
          <span className={styles.statusLight} />
          <span>PostgreSQL Connected</span>
        </div>
      </div>

      <div className={styles.showcaseNav}>
        <button
          className={`${styles.showcaseTab} ${activeTab === "databases" ? styles.showcaseTabActive : ""}`}
          onClick={() => setActiveTab("databases")}
          type="button"
        >
          <Icon name="database" size={14} />
          Databases
        </button>
        <button
          className={`${styles.showcaseTab} ${activeTab === "query" ? styles.showcaseTabActive : ""}`}
          onClick={() => setActiveTab("query")}
          type="button"
        >
          <Icon name="sql" size={14} />
          SQL Studio
        </button>
        <button
          className={`${styles.showcaseTab} ${activeTab === "connect" ? styles.showcaseTabActive : ""}`}
          onClick={() => setActiveTab("connect")}
          type="button"
        >
          <Icon name="terminal" size={14} />
          Connections
        </button>
      </div>

      <div className={styles.showcaseBody}>
        {activeTab === "databases" && (
          <div className={styles.showcaseDatabases}>
            <div className={styles.showcaseSummaryBar}>
              {SHOWCASE_SUMMARY.map((item) => (
                <div className={styles.summaryItem} key={item.label}>
                  <span className={styles.summaryLabel}>{item.label}</span>
                  <strong
                    className={item.positive ? styles.summaryValuePositive : styles.summaryValue}
                  >
                    {item.value}
                  </strong>
                </div>
              ))}
            </div>

            <div className={styles.miniTable}>
              <div className={styles.miniTableRowHeader}>
                <span>Database</span>
                <span>Size</span>
                <span>Connections</span>
                <span>Status</span>
              </div>
              {SHOWCASE_DATABASES.map((db) => (
                <div className={styles.miniTableRow} key={db.name}>
                  <div className={styles.dbNameCol}>
                    <Icon name="database" size={14} />
                    <strong>{db.name}</strong>
                  </div>
                  <span>{db.size}</span>
                  <span>{db.connections}</span>
                  <span className={styles.statusBadgeGreen}>{db.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "query" && (
          <div className={styles.showcaseQuery}>
            <div className={styles.queryEditorBar}>
              <span className={styles.queryLabel}>Query: app_production</span>
              <span className={styles.queryMeta}>Executed in 1.4 ms · 3 rows</span>
            </div>
            <div className={styles.querySnippet}>
              <code>
                <span className={styles.sqlKeyword}>SELECT</span> id, full_name, role, status{" "}
                <span className={styles.sqlKeyword}>FROM</span> team_members{" "}
                <span className={styles.sqlKeyword}>WHERE</span> active ={" "}
                <span className={styles.sqlLiteral}>true</span>{" "}
                <span className={styles.sqlKeyword}>LIMIT</span>{" "}
                <span className={styles.sqlLiteral}>3</span>;
              </code>
            </div>
            <div className={styles.miniTable}>
              <div className={styles.miniTableRowHeader}>
                <span>id</span>
                <span>full_name</span>
                <span>role</span>
                <span>status</span>
              </div>
              {SHOWCASE_QUERY_ROWS.map((row) => (
                <div className={styles.miniTableRow} key={row.id}>
                  <span className={styles.monoText}>{row.id}</span>
                  <span>{row.fullName}</span>
                  <span>{row.role}</span>
                  <span className={styles.statusBadgeGreen}>{row.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "connect" && (
          <div className={styles.showcaseConnect}>
            <div className={styles.connectIntro}>
              <strong>Instant App Connection</strong>
              <span>Pre-configured connection string for your active database role.</span>
            </div>
            <div className={styles.connectBox}>
              <code>{SAMPLE_CONNECTION_STRING}</code>
              <button className={styles.copyButton} onClick={copySampleConnection} type="button">
                {copiedSnippet ? (
                  <>
                    <Icon name="check" size={13} /> Copied!
                  </>
                ) : (
                  <>
                    <Icon name="copy" size={13} /> Copy String
                  </>
                )}
              </button>
            </div>
            <div className={styles.driverPills}>
              {DRIVER_PILLS.map((pill) => (
                <span className={styles.driverPill} key={pill}>
                  {pill}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
