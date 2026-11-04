"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { formatBytes, StorageCapacity, type DatabaseQuotaChange } from "./storage-capacity";
import {
  type Database,
  apiRequest,
  PageHeader,
  Button,
  Panel,
  Notice,
  Loading,
  Empty,
  DatabaseTable,
  DeleteDatabaseDialog,
  ErrorNotice,
  useDatabases,
} from "./live-shared";
import styles from "./live-screens.module.css";

export function LiveDatabasesScreen({ page = "list" }: { page?: "list" | "new" }) {
  const { databases, error, loading, refresh, status } = useDatabases();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [quotaSavingName, setQuotaSavingName] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const deletingDatabase = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<Database | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function createDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest("/api/nanogres/databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setName("");
      setMessage(`Database “${name}” created.`);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not create database.");
    } finally {
      setSaving(false);
    }
  }

  async function saveDatabaseQuota(database: string, quota: DatabaseQuotaChange) {
    setQuotaSavingName(database);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest(`/api/nanogres/databases/${encodeURIComponent(database)}/quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quota),
      });
      setMessage(
        quota.mode === "auto"
          ? `Database “${database}” returned to Auto sizing.`
          : `Custom maximum set for “${database}” at ${formatBytes(quota.maxBytes)}.`,
      );
      await refresh();
    } finally {
      setQuotaSavingName(null);
    }
  }

  function requestDatabaseDeletion(database: Database) {
    setActionError(null);
    setDeleteTarget(database);
  }

  function cancelDatabaseDeletion() {
    if (busyName) return;
    setDeleteTarget(null);
    setActionError(null);
  }

  async function confirmDatabaseDeletion(database: Database) {
    if (deletingDatabase.current) return;
    deletingDatabase.current = true;
    setBusyName(database.name);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest(`/api/nanogres/databases/${encodeURIComponent(database.name)}`, {
        method: "DELETE",
      });
      setMessage(`Database “${database.name}” deleted.`);
      setDeleteTarget(null);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not delete database.");
    } finally {
      deletingDatabase.current = false;
      setBusyName(null);
    }
  }

  return (
    <div className={styles.screen}>
      <PageHeader
        description="Create databases and review size, owners, and active connections."
        eyebrow="DATA"
        title={page === "new" ? "Create a database" : "Databases"}
      />
      <ErrorNotice error={error} onRetry={() => void refresh()} />
      <ErrorNotice error={deleteTarget ? null : actionError} />
      {message ? <Notice tone="info">{message}</Notice> : null}
      {page === "new" ? (
        <>
          <Link href="/databases">← Back to databases</Link>
          <Panel
            title="Create a database"
            detail="Names use lowercase letters, numbers, and underscores."
          >
            <form className={styles.form} onSubmit={createDatabase}>
              <label htmlFor="database-name">Database name</label>
              <div className={styles.formRow}>
                <input
                  autoComplete="off"
                  id="database-name"
                  maxLength={63}
                  minLength={2}
                  onChange={(event) => setName(event.target.value)}
                  pattern="[a-z][a-z0-9_]{1,62}"
                  placeholder="my_project"
                  required
                  value={name}
                />
                <Button disabled={saving} type="submit">
                  {saving ? "Creating…" : "Create database"}
                </Button>
              </div>
            </form>
          </Panel>
        </>
      ) : (
        <>
          <Link className={styles.primaryButton} href="/databases/new">
            Create database
          </Link>
          {status ? (
            <Panel
              title="Storage capacity"
              detail="Current disk space and per-database growth room"
            >
              <StorageCapacity
                databases={databases}
                disk={status.disk}
                growthPercent={status.databaseGrowthPercent ?? 25}
                reserveBytes={status.databaseQuotaReserveBytes}
                onSaveQuota={saveDatabaseQuota}
                savingQuotaName={quotaSavingName}
              />
            </Panel>
          ) : null}
          <Panel
            title="All databases"
            detail={
              loading
                ? "Refreshing inventory…"
                : `${databases.length} database${databases.length === 1 ? "" : "s"}`
            }
          >
            {loading && !databases.length ? (
              <Loading />
            ) : error && !databases.length ? (
              <Empty>
                Nanogres could not load the database list. Use Try again above to retry.
              </Empty>
            ) : (
              <DatabaseTable
                busyName={busyName}
                databases={databases}
                onRequestDelete={requestDatabaseDeletion}
              />
            )}
          </Panel>
          <Notice tone="info">
            Postgres remains private on the VPS. Database access is granted through the Access &amp;
            roles page.
          </Notice>
        </>
      )}
      {deleteTarget ? (
        <DeleteDatabaseDialog
          busy={busyName === deleteTarget.name}
          database={deleteTarget}
          error={actionError}
          onCancel={cancelDatabaseDeletion}
          onConfirm={() => void confirmDatabaseDeletion(deleteTarget)}
        />
      ) : null}
    </div>
  );
}
