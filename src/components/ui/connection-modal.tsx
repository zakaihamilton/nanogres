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

export function ConnectionModal({
  database,
  host = "127.0.0.1",
  port = 5432,
  user = "your_role",
  isOpen,
  onClose,
}: {
  database: string;
  host?: string;
  port?: number;
  user?: string;
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

  const uri = `postgresql://${user}:[PASSWORD]@${host}:${port}/${database}?sslmode=prefer`;
  const psql = `psql "postgresql://${user}:[PASSWORD]@${host}:${port}/${database}"`;
  const node = `import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const client = await pool.connect();
const res = await client.query("SELECT NOW()");
console.log(res.rows[0]);
client.release();`;

  const python = `import psycopg2

conn = psycopg2.connect(
    dbname="${database}",
    user="${user}",
    password="[PASSWORD]",
    host="${host}",
    port=${port}
)
with conn.cursor() as cur:
    cur.execute("SELECT NOW()")
    print(cur.fetchone())
conn.close()`;

  const go = `package main

import (
    "context"
    "fmt"
    "os"
    "github.com/jackc/pgx/v5"
)

func main() {
    conn, err := pgx.Connect(context.Background(), "${uri}")
    if err != nil {
        panic(err)
    }
    defer conn.Close(context.Background())

    var now string
    err = conn.QueryRow(context.Background(), "SELECT NOW()").Scan(&now)
    fmt.Println(now)
}`;

  const env = `DATABASE_URL="${uri}"
PGHOST="${host}"
PGPORT="${port}"
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
            Use a login role created for this organization&apos;s database in Nanogres Access.
            Replace <code>[PASSWORD]</code> with that role&apos;s password. PostgreSQL stays private
            on the VPS; connect through your approved network or tunnel.
          </p>
        </div>
      </dialog>
    </>
  );
}
