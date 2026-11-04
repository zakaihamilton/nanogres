"use client";

import { useState, useEffect } from "react";
import { nanogresToast } from "./toast";
import styles from "./connection-modal.module.css";

type Tab = "uri" | "psql" | "node" | "python" | "go" | "env";

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

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

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

  return (
    <div className={styles.overlay}>
      <button
        aria-label="Close modal overlay"
        className={styles.backdrop}
        onClick={onClose}
        type="button"
      />
      <div
        aria-labelledby="conn-modal-title"
        aria-modal="true"
        className={styles.modal}
        role="dialog"
      >
        <div className={styles.modalHeader}>
          <h2 id="conn-modal-title" className={styles.modalTitle}>
            Connect to “{database}”
          </h2>
          <button
            className={styles.closeButton}
            onClick={onClose}
            type="button"
            aria-label="Close modal"
          >
            ×
          </button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.tabs} role="tablist">
            {(
              [
                ["uri", "Connection URI"],
                ["psql", "psql CLI"],
                ["node", "Node.js (pg)"],
                ["python", "Python (psycopg)"],
                ["go", "Go (pgx)"],
                ["env", ".env"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={`${styles.tab} ${tab === key ? styles.tabActive : ""}`}
                onClick={() => setTab(key)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          <div className={styles.codeBox}>
            <button className={styles.copyButton} onClick={copy} type="button">
              {copied ? "Copied!" : "Copy"}
            </button>
            <code>{getContent()}</code>
          </div>

          <p className={styles.note}>
            Use a login role created for this organization's database in Nanogres Access. Replace{" "}
            <code>[PASSWORD]</code> with that role's password. PostgreSQL stays private on the VPS;
            connect through your approved network or tunnel.
          </p>
        </div>
      </div>
    </div>
  );
}
