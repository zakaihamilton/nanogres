// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Keyboard-focusable dashboard regions allow keyboard scrolling of wide tables.
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import type { Database } from "./live-api";
import { Button, Empty } from "./live-primitives";
import styles from "./live-primitives.module.css";
import { formatBytes } from "./storage-capacity";

export function DatabaseTable({
  databases,
  onRequestDelete,
  onConnect,
  busyName,
  emptyMessage,
}: {
  databases: Database[];
  onRequestDelete?: (database: Database) => void;
  onConnect?: (databaseName: string) => void;
  busyName?: string | null;
  emptyMessage?: ReactNode;
}) {
  if (!databases.length) {
    return <Empty>{emptyMessage || "No user databases yet. Create one to get started."}</Empty>;
  }
  return (
    <div aria-label="Databases" className={styles.tableWrap} role="region" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">Database</th>
            <th scope="col">Owner</th>
            <th scope="col">Size</th>
            <th scope="col">Connections</th>
            <th scope="col">Encoding</th>
            <th scope="col">
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {databases.map((database) => (
            <tr key={database.name}>
              <td>
                <Tooltip label="Open database details">
                  <Link
                    className={styles.databaseName}
                    href={`/databases/${encodeURIComponent(database.name)}`}
                  >
                    {database.name}
                  </Link>
                </Tooltip>
                {database.systemDatabase ? (
                  <small className={styles.systemTag}>system</small>
                ) : null}
              </td>
              <td>{database.owner}</td>
              <td>{formatBytes(database.sizeBytes)}</td>
              <td>
                {database.connections} / {database.maxConnections}
              </td>
              <td>{database.encoding}</td>
              <td className={styles.actionCell}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {onConnect ? (
                    <button
                      className={styles.rowAction}
                      onClick={() => onConnect(database.name)}
                      type="button"
                    >
                      Connect
                    </button>
                  ) : null}
                  <Link
                    className={styles.rowAction}
                    href={`/databases/${encodeURIComponent(database.name)}`}
                  >
                    Manage
                  </Link>
                  {onRequestDelete ? (
                    database.systemDatabase ? (
                      <span className={styles.muted}>Protected</span>
                    ) : (
                      <Button
                        ariaLabel={`Delete ${database.name}`}
                        disabled={busyName === database.name}
                        onClick={() => onRequestDelete(database)}
                        variant="danger"
                      >
                        {busyName === database.name ? "Deleting…" : "Delete"}
                      </Button>
                    )
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
