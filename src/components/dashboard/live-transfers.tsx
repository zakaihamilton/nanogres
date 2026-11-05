"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import {
  apiRequest,
  Button,
  Empty,
  ErrorNotice,
  formatDate,
  Notice,
  PageHeader,
  Panel,
  useDatabases,
} from "./live-shared";
import styles from "./live-screens.module.css";

type TransferJob = {
  transferId: string;
  direction: "import" | "export";
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  phase: string;
  message: string;
  sourceDatabase: string;
  targetDatabase: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  recoveryBackupRetained?: boolean;
  canCancel?: boolean;
};

type Direction = "import" | "export";

function active(job: TransferJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "cancelling";
}

function jobTitle(job: TransferJob): string {
  return job.direction === "import"
    ? `Import into ${job.targetDatabase}`
    : `Export ${job.sourceDatabase}`;
}

export function LiveTransfersScreen() {
  const { databases, loading: databasesLoading, refresh: refreshDatabases } = useDatabases();
  const userDatabases = databases.filter((database) => !database.systemDatabase);
  const [direction, setDirection] = useState<Direction>("import");
  const [connectionString, setConnectionString] = useState("");
  const [sourceDatabase, setSourceDatabase] = useState("");
  const [targetDatabase, setTargetDatabase] = useState("");
  const [importMode, setImportMode] = useState<"new" | "replace">("new");
  const [exportMode, setExportMode] = useState<"empty" | "replace">("empty");
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const observedStatuses = useRef(new Map<string, TransferJob["status"]>());
  const hasObservedJobs = useRef(false);

  const refreshJobs = useCallback(async () => {
    try {
      const result = await apiRequest<{ transfers: TransferJob[] }>("/api/nanogres/transfers");
      setJobs(result.transfers);
      setError(null);
      const refreshForExistingSuccess =
        !hasObservedJobs.current &&
        result.transfers.some(
          (job) => job.status === "succeeded" && !observedStatuses.current.has(job.transferId),
        );
      for (const job of result.transfers) {
        const previous = observedStatuses.current.get(job.transferId);
        if (job.status === "succeeded" && previous && previous !== "succeeded") {
          await refreshDatabases();
        }
        observedStatuses.current.set(job.transferId, job.status);
      }
      hasObservedJobs.current = true;
      if (refreshForExistingSuccess) await refreshDatabases();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load database transfers.");
    } finally {
      setLoadingJobs(false);
    }
  }, [refreshDatabases]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshJobs(), 0);
    const timer = window.setInterval(() => void refreshJobs(), 3000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [refreshJobs]);

  async function startTransfer() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiRequest<{ transfer: TransferJob }>("/api/nanogres/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          direction === "import"
            ? {
                direction,
                targetMode: importMode,
                targetDatabase,
                connectionString,
              }
            : {
                direction,
                targetMode: exportMode,
                sourceDatabase,
                connectionString,
              },
        ),
      });
      observedStatuses.current.set(
        result.transfer.transferId,
        result.transfer.status === "succeeded" ? "running" : result.transfer.status,
      );
      setConnectionString("");
      setMessage("Transfer started. You can leave this page while it runs.");
      await refreshJobs();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this transfer.");
    } finally {
      setConnectionString("");
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (direction === "import" && importMode === "replace") {
      setConfirmReplace(true);
    } else if (direction === "export" && exportMode === "replace") {
      setConfirmReplace(true);
    } else {
      void startTransfer();
    }
  }

  async function cancelTransfer(job: TransferJob) {
    try {
      await apiRequest(`/api/nanogres/transfers/${job.transferId}`, { method: "DELETE" });
      await refreshJobs();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel this transfer.");
    }
  }

  const replaceMessage =
    direction === "import"
      ? `Replace “${targetDatabase}” with the external database contents? Nanogres will keep the current database until the replacement is ready, then switch over and disconnect active sessions.`
      : `Replace the external database with “${sourceDatabase}”? Nanogres will make a temporary rollback copy first, then remove its user schemas and restore this database.`;

  return (
    <div className={styles.screen}>
      {confirmReplace ? (
        <ConfirmDialog
          title="Confirm database replacement"
          confirmLabel="Replace database"
          message={replaceMessage}
          onCancel={() => setConfirmReplace(false)}
          onConfirm={() => {
            setConfirmReplace(false);
            void startTransfer();
          }}
        />
      ) : null}
      <PageHeader
        description="Move a complete PostgreSQL database directly between Nanogres and an existing connection."
        eyebrow="RECOVERY"
        title="Database transfers"
      />
      <ErrorNotice error={error} />
      {message ? <Notice tone="info">{message}</Notice> : null}
      <Notice tone="warning">
        Connections are used once and then discarded. The VPS must be able to reach the database;
        public-hosted providers may require the VPS IP to be allowlisted. Transfers require TLS.
      </Notice>
      <Panel
        title="Start a transfer"
        detail="Full database schema and data; roles and grants are not transferred."
      >
        <form className={styles.formGrid} method="post" onSubmit={submit}>
          <div className={styles.field}>
            <label htmlFor="transfer-direction">Direction</label>
            <Select
              id="transfer-direction"
              value={direction}
              onChange={(value) => setDirection(value as Direction)}
            >
              <option value="import">Import into Nanogres</option>
              <option value="export">Export from Nanogres</option>
            </Select>
          </div>
          {direction === "import" ? (
            <>
              <div className={styles.field}>
                <label htmlFor="import-mode">Nanogres destination</label>
                <Select
                  id="import-mode"
                  value={importMode}
                  onChange={(value) => setImportMode(value as "new" | "replace")}
                >
                  <option value="new">Create a new database</option>
                  <option value="replace">Replace an existing database</option>
                </Select>
              </div>
              <div className={styles.field}>
                <label htmlFor="import-target">
                  {importMode === "new" ? "New database name" : "Database to replace"}
                </label>
                {importMode === "new" ? (
                  <input
                    autoComplete="off"
                    id="import-target"
                    maxLength={37}
                    pattern="[a-z][a-z0-9_]{0,36}"
                    placeholder="app_analytics"
                    required
                    value={targetDatabase}
                    onChange={(event) => setTargetDatabase(event.target.value)}
                  />
                ) : (
                  <Select
                    id="import-target"
                    value={targetDatabase}
                    onChange={setTargetDatabase}
                    required
                  >
                    <option value="" disabled>
                      Select a database
                    </option>
                    {userDatabases.map((database) => (
                      <option value={database.name} key={database.name}>
                        {database.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              <div className={styles.field}>
                <label htmlFor="external-connection">Source PostgreSQL connection string</label>
                <input
                  autoCapitalize="off"
                  autoComplete="off"
                  id="external-connection"
                  name="external-connection"
                  placeholder="postgresql://user:password@host:5432/database?sslmode=require"
                  required
                  spellCheck={false}
                  type="password"
                  value={connectionString}
                  onChange={(event) => setConnectionString(event.target.value)}
                />
                <small>
                  Use a direct database connection. TLS certificate verification is required.
                </small>
              </div>
            </>
          ) : (
            <>
              <div className={styles.field}>
                <label htmlFor="export-source">Nanogres source database</label>
                <Select
                  id="export-source"
                  value={sourceDatabase}
                  onChange={setSourceDatabase}
                  required
                >
                  <option value="" disabled>
                    Select a database
                  </option>
                  {userDatabases.map((database) => (
                    <option value={database.name} key={database.name}>
                      {database.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className={styles.field}>
                <label htmlFor="export-mode">External destination behavior</label>
                <Select
                  id="export-mode"
                  value={exportMode}
                  onChange={(value) => setExportMode(value as "empty" | "replace")}
                >
                  <option value="empty">Require an empty database</option>
                  <option value="replace">Replace destination contents</option>
                </Select>
              </div>
              <div className={styles.field}>
                <label htmlFor="external-connection">
                  Destination PostgreSQL connection string
                </label>
                <input
                  autoCapitalize="off"
                  autoComplete="off"
                  id="external-connection"
                  name="external-connection"
                  placeholder="postgresql://user:password@host:5432/database?sslmode=require"
                  required
                  spellCheck={false}
                  type="password"
                  value={connectionString}
                  onChange={(event) => setConnectionString(event.target.value)}
                />
                <small>
                  For replace, Nanogres first saves a temporary rollback copy on the VPS.
                </small>
              </div>
            </>
          )}
          <div className={styles.formActions}>
            <Button
              type="submit"
              disabled={busy || (direction === "export" && userDatabases.length === 0)}
            >
              {busy ? "Starting…" : direction === "import" ? "Start import" : "Start export"}
            </Button>
          </div>
        </form>
      </Panel>
      <Panel
        title="Recent transfers"
        detail="Status refreshes automatically while this page is open."
      >
        {loadingJobs ? (
          <div className={styles.loading}>Loading transfers…</div>
        ) : jobs.length === 0 ? (
          <Empty>No database transfers yet.</Empty>
        ) : (
          <div className={styles.activityList}>
            {jobs.map((job) => (
              <div className={styles.activityItem} key={job.transferId}>
                <span className={styles.activityMark} aria-hidden="true" />
                <div>
                  <strong>{jobTitle(job)}</strong>
                  <p>{job.message}</p>
                  {job.recoveryBackupRetained ? (
                    <p>
                      A recovery copy remains on the VPS because automatic rollback did not finish.
                    </p>
                  ) : null}
                  <p>{formatDate(job.createdAt)}</p>
                </div>
                {active(job) && job.canCancel !== false ? (
                  <Button variant="secondary" onClick={() => void cancelTransfer(job)}>
                    Cancel
                  </Button>
                ) : active(job) ? (
                  <span>{job.status === "cancelling" ? "Cancelling…" : "Finalizing"}</span>
                ) : (
                  <span>{job.status === "succeeded" ? "Complete" : job.status}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
      {direction === "import" && importMode === "replace" && databasesLoading ? (
        <span className={styles.srOnly}>Loading Nanogres databases</span>
      ) : null}
    </div>
  );
}
