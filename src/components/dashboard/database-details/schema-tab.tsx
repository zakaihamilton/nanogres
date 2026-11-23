"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "../database-details.module.css";
import { Icon } from "../icons";
import { Button, Empty, Loading } from "../live-primitives";
import liveStyles from "../live-primitives.module.css";
import { formatBytes } from "../storage-capacity";
import { DatabaseTabPanel } from "./tab-panel";
import type { TableMeta } from "./types";

export function SchemaTab({
  databaseName,
  tables,
  loading,
  onOpenCreateTable,
  onMaintenance,
}: {
  databaseName: string;
  tables: TableMeta[];
  loading: boolean;
  onOpenCreateTable: () => void;
  onMaintenance: (action: "vacuum" | "analyze" | "reindex", table?: string) => Promise<void>;
}) {
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const currentTable = tables.find((table) => table.name === (selectedTable || tables[0]?.name));

  return (
    <DatabaseTabPanel tab="schema">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
          Inspect tables, columns, indexes, and run DDL operations.
        </span>
        <Button onClick={onOpenCreateTable} variant="primary">
          <Icon name="plus" size={14} /> Create Table
        </Button>
      </div>

      {loading ? (
        <Loading label="Reading PostgreSQL catalog..." />
      ) : !tables.length ? (
        <Empty>No user tables found in this database. Click Create Table to add one.</Empty>
      ) : (
        <div className={styles.schemaBrowser}>
          <div className={styles.tableListPanel}>
            <div className={styles.tableListTitle}>
              <span>Tables ({tables.length})</span>
            </div>
            <div className={styles.tableTree}>
              {tables.map((tbl) => {
                const isSelected = tbl.name === (currentTable?.name || tables[0]?.name);
                return (
                  <button
                    key={tbl.name}
                    className={`${styles.tableItem} ${isSelected ? styles.tableItemActive : ""}`}
                    onClick={() => setSelectedTable(tbl.name)}
                    type="button"
                  >
                    <span>{tbl.name}</span>
                    <small style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                      {tbl.estimatedRows} rows
                    </small>
                  </button>
                );
              })}
            </div>
          </div>

          {currentTable ? (
            <div className={styles.tableDetailPanel}>
              <div className={styles.detailHeader}>
                <div>
                  <h2 className={styles.detailTitle}>{currentTable.name}</h2>
                  <div className={styles.statsStrip}>
                    <span>~{currentTable.estimatedRows} rows</span>
                    <span>·</span>
                    <span>Table size: {formatBytes(currentTable.tableSizeBytes)}</span>
                    <span>·</span>
                    <span>Index size: {formatBytes(currentTable.indexSizeBytes)}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Link
                    className={liveStyles.actionSecondaryButton}
                    href={`/sql?db=${encodeURIComponent(databaseName)}&q=SELECT * FROM ${encodeURIComponent(currentTable.name)} LIMIT 100;`}
                  >
                    Query Table →
                  </Link>
                  <Button
                    onClick={() => void onMaintenance("vacuum", currentTable.name)}
                    variant="secondary"
                  >
                    Vacuum
                  </Button>
                </div>
              </div>

              <div>
                <h3 style={{ fontSize: 13, marginBottom: 8, color: "var(--ink)" }}>
                  Columns ({currentTable.columns.length})
                </h3>
                <div className={liveStyles.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Type</th>
                        <th>Nullable</th>
                        <th>Default</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentTable.columns.map((col) => (
                        <tr key={col.name}>
                          <td>
                            <strong>{col.name}</strong>
                            {col.isPrimaryKey ? <span className={styles.pkBadge}>PK</span> : null}
                            {col.isForeignKey ? <span className={styles.fkBadge}>FK</span> : null}
                          </td>
                          <td>
                            <code>{col.type}</code>
                          </td>
                          <td>{col.nullable ? "YES" : "NO"}</td>
                          <td>{col.defaultValue ? <code>{col.defaultValue}</code> : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {currentTable.indexes?.length ? (
                <div>
                  <h3 style={{ fontSize: 13, marginBottom: 8, color: "var(--ink)" }}>
                    Indexes ({currentTable.indexes.length})
                  </h3>
                  <div className={liveStyles.tableWrap}>
                    <table>
                      <thead>
                        <tr>
                          <th>Index Name</th>
                          <th>Size</th>
                          <th>Attributes</th>
                          <th>Definition</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentTable.indexes.map((idx) => (
                          <tr key={idx.name}>
                            <td>
                              <strong>{idx.name}</strong>
                            </td>
                            <td>{formatBytes(idx.sizeBytes)}</td>
                            <td>{idx.isUnique ? "UNIQUE" : "STANDARD"}</td>
                            <td>
                              <code style={{ fontSize: 11 }}>{idx.definition}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </DatabaseTabPanel>
  );
}
