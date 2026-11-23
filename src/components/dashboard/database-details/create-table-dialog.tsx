"use client";

import { Dialog } from "panel-frame-ui";
import { type FormEvent, useRef, useState } from "react";
import { nanogresToast } from "@/components/ui/toast";
import styles from "../database-details.module.css";
import { apiRequest } from "../live-api";
import { Button } from "../live-primitives";

export function CreateTableDialog({
  databaseName,
  open,
  onOpenChange,
  onCreated,
}: {
  databaseName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const [newTableName, setNewTableName] = useState("");
  const [newTableCols, setNewTableCols] = useState(
    "id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), name TEXT NOT NULL",
  );
  const [isDdlSaving, setIsDdlSaving] = useState(false);
  const newTableNameInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  async function handleCreateTable(event: FormEvent) {
    event.preventDefault();
    if (!newTableName.trim()) return;
    setIsDdlSaving(true);
    try {
      const cols = newTableCols.split(",").map((columnDef) => {
        const parts = columnDef.trim().split(/\s+/);
        const name = parts[0];
        const type = parts.slice(1).join(" ");
        return {
          name,
          type: type || "text",
          nullable: !type.toUpperCase().includes("NOT NULL"),
          primaryKey: type.toUpperCase().includes("PRIMARY KEY"),
        };
      });

      await apiRequest(`/api/nanogres/databases/${encodeURIComponent(databaseName)}/ddl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "create_table",
          name: newTableName.trim(),
          columns: cols,
        }),
      });
      nanogresToast.success(`Table “${newTableName}” created successfully`);
      onOpenChange(false);
      setNewTableName("");
      void onCreated();
    } catch (err) {
      nanogresToast.error(err instanceof Error ? err.message : "Failed to create table");
    } finally {
      setIsDdlSaving(false);
    }
  }

  return (
    <Dialog
      className={styles.modalContainer}
      description="Define a name and columns for the new table."
      initialFocusRef={newTableNameInputRef}
      onOpenChange={onOpenChange}
      open
      title={`Create Table in “${databaseName}”`}
    >
      <form onSubmit={handleCreateTable}>
        <div className={styles.formField} style={{ marginBottom: 12 }}>
          <label htmlFor="new-tbl-name">Table name</label>
          <input
            ref={newTableNameInputRef}
            id="new-tbl-name"
            onChange={(event) => setNewTableName(event.target.value)}
            placeholder="e.g. users, orders, posts"
            required
            value={newTableName}
          />
        </div>
        <div className={styles.formField} style={{ marginBottom: 16 }}>
          <label htmlFor="new-tbl-cols">Columns definition (comma-separated)</label>
          <input
            id="new-tbl-cols"
            onChange={(event) => setNewTableCols(event.target.value)}
            placeholder="id SERIAL PRIMARY KEY, name TEXT NOT NULL"
            required
            value={newTableCols}
          />
        </div>
        <div className={styles.dialogButtons}>
          <Button onClick={() => onOpenChange(false)} variant="secondary">
            Cancel
          </Button>
          <Button disabled={isDdlSaving} type="submit" variant="primary">
            {isDdlSaving ? "Creating..." : "Create Table"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
