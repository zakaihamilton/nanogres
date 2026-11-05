"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { formatBytes, StorageCapacity, type DatabaseQuotaChange } from "./storage-capacity";
import { ConnectionModal } from "@/components/ui/connection-modal";
import { Icon } from "./icons";
import { TENANT_NAME_MAX_LENGTH, TENANT_NAME_PATTERN } from "@/lib/tenant-names";
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

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [connectDb, setConnectDb] = useState<string | null>(null);

  const filteredDatabases = useMemo(() => {
    return databases.filter((db) => {
      if (!showSystem && db.systemDatabase) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return db.name.toLowerCase().includes(q) || db.owner.toLowerCase().includes(q);
      }
      return true;
    });
  }, [databases, showSystem, searchQuery]);

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
        action={
          page === "list" ? (
            <div className={styles.actionGroup}>
              <Link className={styles.actionSecondaryButton} href="/sql">
                <Icon name="sql" size={14} />
                SQL Editor
              </Link>
              <Link className={styles.primaryButton} href="/databases/new">
                Create database
              </Link>
            </div>
          ) : undefined
        }
        description="Create databases and review sizes, schemas, live queries, and quotas."
        eyebrow="DATA"
        title={page === "new" ? "Create a database" : "Databases"}
      />
      <ErrorNotice error={error} onRetry={() => void refresh()} />
      <ErrorNotice error={deleteTarget ? null : actionError} />
      {message ? <Notice tone="info">{message}</Notice> : null}

      {page === "new" ? (
        <>
          <Link className={styles.backLink} href="/databases">
            ← Back to databases
          </Link>
          <Panel
            title="Create a database"
            detail={`Lowercase letters, numbers, and underscores; max ${TENANT_NAME_MAX_LENGTH} characters.`}
          >
            <form className={styles.form} method="post" onSubmit={createDatabase}>
              <label htmlFor="database-name">Database name</label>
              <div className={styles.formRow}>
                <input
                  autoComplete="off"
                  id="database-name"
                  maxLength={TENANT_NAME_MAX_LENGTH}
                  minLength={2}
                  onChange={(event) => setName(event.target.value)}
                  pattern={TENANT_NAME_PATTERN}
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

          <div className={styles.tableToolbar}>
            <div className={styles.searchInputWrap}>
              <Icon name="search" size={14} />
              <input
                aria-label="Filter databases"
                className={styles.searchInput}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search databases..."
                value={searchQuery}
              />
            </div>
            <label className={styles.filterToggle}>
              <input
                checked={showSystem}
                className={styles.filterCheckbox}
                onChange={(e) => setShowSystem(e.target.checked)}
                type="checkbox"
              />
              Show system databases
            </label>
          </div>

          <Panel
            title="All databases"
            detail={
              loading
                ? "Refreshing inventory…"
                : `${filteredDatabases.length} database${filteredDatabases.length === 1 ? "" : "s"}`
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
                databases={filteredDatabases}
                emptyMessage={
                  searchQuery.trim()
                    ? `No databases match your search “${searchQuery}”.`
                    : undefined
                }
                onConnect={(dbName) => setConnectDb(dbName)}
                onRequestDelete={requestDatabaseDeletion}
              />
            )}
          </Panel>
          <Notice tone="info">
            Click any database name to open its deep workspace (Schema &amp; Tables, Live Queries,
            Quotas, and Backups).
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

      <ConnectionModal
        database={databases.find((database) => database.name === connectDb)?.connectionName ?? ""}
        isOpen={databases.some((database) => database.name === connectDb)}
        onClose={() => setConnectDb(null)}
      />
    </div>
  );
}
