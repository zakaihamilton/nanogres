"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Select } from "@/components/ui/select";
import {
  type BackupTransferCallbacks,
  downloadBackupFile,
  openBackupSaveWriter,
} from "@/lib/backup-transfer";
import { apiRequest, type Backup, type Database } from "../live-api";
import { Button, Panel } from "../live-primitives";
import styles from "../live-primitives.module.css";

export function BackupCreateView({
  userDatabases,
  databaseLoading,
  databaseError,
  transferBusy,
  onBusyChange,
  onProgress,
  onError,
  onMessage,
  onCreated,
}: BackupTransferCallbacks & {
  userDatabases: Database[];
  databaseLoading: boolean;
  databaseError: string | null;
  onCreated: () => Promise<void>;
}) {
  const searchParams = useSearchParams();
  const [database, setDatabase] = useState(
    () => searchParams.get("db") || searchParams.get("database") || "",
  );
  const selectedDatabase = database || userDatabases[0]?.name || "";
  const [saving, setSaving] = useState(false);

  async function createBackupAndDownload() {
    if (!selectedDatabase) return;
    const suggestedName = `${selectedDatabase}-${new Date().toISOString().slice(0, 10)}.dump`;
    const { cancelled, writer } = await openBackupSaveWriter(suggestedName, onError);
    if (cancelled) return;

    setSaving(true);
    onBusyChange(true);
    onError(null);
    onMessage(null);
    try {
      const result = await apiRequest<{ backup: Backup }>("/api/nanogres/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database: selectedDatabase }),
      });
      await onCreated();
      await downloadBackupFile(result.backup, writer, onProgress);
      onMessage(`Created and downloaded ${result.backup.filename}.`);
    } catch (cause) {
      await writer?.abort?.().catch(() => {});
      onError(cause instanceof Error ? cause.message : "Could not create backup.");
      await onCreated();
    } finally {
      setSaving(false);
      onBusyChange(false);
      onProgress(null);
    }
  }

  return (
    <Panel
      title="Create a backup now"
      detail="Create a compressed PostgreSQL dump and save a copy to your device."
    >
      <div className={styles.inlineForm}>
        <label className={styles.srOnly} htmlFor="backup-database">
          Database
        </label>
        <Select
          id="backup-database"
          disabled={!userDatabases.length || transferBusy}
          onChange={setDatabase}
          value={selectedDatabase}
        >
          {!selectedDatabase ? (
            <option value="">
              {databaseLoading
                ? "Loading databases…"
                : databaseError
                  ? "Could not load databases"
                  : "No user databases"}
            </option>
          ) : null}
          {userDatabases.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </Select>
        <Button
          disabled={transferBusy || !selectedDatabase}
          onClick={() => void createBackupAndDownload()}
        >
          {saving ? "Creating and downloading…" : "Create & download .dump"}
        </Button>
      </div>
    </Panel>
  );
}
