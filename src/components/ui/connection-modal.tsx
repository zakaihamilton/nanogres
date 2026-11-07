"use client";

import { useState, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { nanogresToast } from "./toast";
import styles from "./connection-modal.module.css";

type Tab = "uri" | "psql" | "node" | "python" | "go" | "env";
const connectionTabs: Array<[Tab, string]> = [
  ["uri", "Connection URI"],
  ["psql", "psql CLI"],
  ["node", "Node.js (pg)"],
  ["python", "Python (psycopg)"],
  ["go", "Go (pgx)"],
  ["env", ".env"],
];

function configuredPort(value: string | undefined, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

const defaultConnectionHost =
  process.env.NEXT_PUBLIC_NANOGRES_DB_HOST || "nanogres.duckdns.org";
const defaultRuntimePort = configuredPort(process.env.NEXT_PUBLIC_NANOGRES_DB_PORT, 6432);
const defaultMigrationPort = configuredPort(
  process.env.NEXT_PUBLIC_NANOGRES_DB_MIGRATION_PORT,
  6433,
);
const connectionSslMode = "verify-full";

export function ConnectionModal({
  database,
  host,
  port,
  user = "your_role",
  migrationRole = false,
  assumeRole,
  isOpen,
  onClose,
}: {
  database: string;
  host?: string;
  port?: number;
  user?: string;
  migrationRole?: boolean;
  assumeRole?: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("uri");
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();

    return () => {
      if (dialog.open) dialog.close();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const connectionHost = host ?? defaultConnectionHost;
  const connectionPort =
    port ?? (migrationRole ? defaultMigrationPort : defaultRuntimePort);
  const safeAssumeRole = assumeRole?.replaceAll('"', '""');
  const roleSql = safeAssumeRole ? `SET ROLE "${safeAssumeRole}"` : "";
  const uri = `postgresql://${user}:[PASSWORD]@${connectionHost}:${connectionPort}/${database}?sslmode=${connectionSslMode}`;
  const psql = roleSql
    ? `psql "${uri}" <<'SQL'
${roleSql};
-- Replace this comment with migration SQL.
SQL`
    : `psql "${uri}"`;
  const node = `import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.${migrationRole ? "MIGRATION_DATABASE_URL" : "DATABASE_URL"},
});

const client = await pool.connect();
try {
  ${roleSql ? `await client.query(${JSON.stringify(roleSql)});\n  ` : ""}const res = await client.query("SELECT NOW()");
  console.log(res.rows[0]);
} finally {
  client.release();
  await pool.end();
}`;

  const python = `import psycopg2

conn = psycopg2.connect(
    dbname="${database}",
    user="${user}",
    password="[PASSWORD]",
    host="${connectionHost}",
    port=${connectionPort},
    sslmode="${connectionSslMode}",
)
with conn.cursor() as cur:
    ${roleSql ? `cur.execute(${JSON.stringify(roleSql)})\n    ` : ""}cur.execute("SELECT NOW()")
    print(cur.fetchone())
conn.close()`;

  const go = `package main

import (
    "context"
    "fmt"
    "github.com/jackc/pgx/v5"
)

func main() {
    conn, err := pgx.Connect(context.Background(), "${uri}")
    if err != nil {
        panic(err)
    }
    defer conn.Close(context.Background())

    ${roleSql ? `if _, err := conn.Exec(context.Background(), ${JSON.stringify(roleSql)}); err != nil {\n        panic(err)\n    }\n\n    ` : ""}var now string
    err = conn.QueryRow(context.Background(), "SELECT NOW()").Scan(&now)
    fmt.Println(now)
}`;

  const env = migrationRole && safeAssumeRole
    ? `MIGRATION_DATABASE_URL="${uri}"
MIGRATION_DATABASE_ROLE="${safeAssumeRole}"`
    : `DATABASE_URL="${uri}"
PGHOST="${connectionHost}"
PGPORT="${connectionPort}"
PGDATABASE="${database}"
PGUSER="${user}"
PGPASSWORD="[YOUR_PASSWORD]"`;

  const getContent = () => {
    switch (tab) {
      case "uri":
        return uri;
      case "psql":
        return psql;
      case "node":
        return node;
      case "python":
        return python;
      case "go":
        return go;
      case "env":
        return env;
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(getContent());
      setCopied(true);
      nanogresToast.success("Connection snippet copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      nanogresToast.error("Failed to copy snippet");
    }
  };

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: Tab) {
    const currentIndex = connectionTabs.findIndex(([key]) => key === currentTab);
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % connectionTabs.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + connectionTabs.length) % connectionTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = connectionTabs.length - 1;
    else return;

    event.preventDefault();
    const nextTab = connectionTabs[nextIndex][0];
    setTab(nextTab);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- Backdrop clicks close the dialog; Escape and the close button remain available. */}
      <dialog
        ref={dialogRef}
        aria-labelledby="conn-modal-title"
        className={styles.modal}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <div className={styles.modalHeader}>
          <h2 id="conn-modal-title" className={styles.modalTitle}>
            Connect to “{database}”
          </h2>
          <button
            ref={closeButtonRef}
            className={styles.closeButton}
            onClick={onClose}
            type="button"
            aria-label="Close modal"
          >
            ×
          </button>
        </div>
        <div className={styles.modalBody}>
          <div aria-label="Connection examples" className={styles.tabs} role="tablist">
            {connectionTabs.map(([key, label], index) => (
              <button
                key={key}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                id={`connection-tab-${key}`}
                role="tab"
                aria-controls="connection-code-panel"
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                className={`${styles.tab} ${tab === key ? styles.tabActive : ""}`}
                onClick={() => setTab(key)}
                onKeyDown={(event) => handleTabKeyDown(event, key)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          <div
            aria-labelledby={`connection-tab-${tab}`}
            className={styles.codeBox}
            id="connection-code-panel"
            role="tabpanel"
            tabIndex={0}
          >
            <button className={styles.copyButton} onClick={copy} type="button">
              {copied ? "Copied!" : "Copy"}
            </button>
            <code>{getContent()}</code>
          </div>

          <p className={styles.note}>
            Use the login role created in Nanogres Access and replace <code>[PASSWORD]</code> with
            its password. These snippets use the public PgBouncer endpoint over TLS; PostgreSQL
            itself stays bound to loopback on the VPS.
            {migrationRole ? (
              <>
                {" "}
                Migrations use the session-pooling port; the snippets apply{" "}
                <code>{roleSql || "SET ROLE the database owner role"}</code> before DDL. For the
                psql tab, replace the comment with your migration SQL.
              </>
            ) : (
              <> Runtime roles use the transaction-pooling port.</>
            )}
          </p>
        </div>
      </dialog>
    </>
  );
}
