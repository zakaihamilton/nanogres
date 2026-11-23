"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { nanogresToast } from "@/components/ui/toast";
import styles from "../database-details.module.css";
import { apiRequest, useApiData } from "../live-api";
import { Button, Empty, ErrorNotice, Loading, Notice, Panel } from "../live-primitives";
import { DatabaseTabPanel } from "./tab-panel";
import type { PgvectorExtension } from "./types";

export function ExtensionsTab({ databaseName }: { databaseName: string }) {
  const extensionsPath = `/api/nanogres/databases/${encodeURIComponent(databaseName)}/extensions`;
  const extensionsQuery = useApiData<{ extension: PgvectorExtension }>(extensionsPath);
  const pgvector = extensionsQuery.data?.extension;
  const [pgvectorSaving, setPgvectorSaving] = useState(false);
  const [confirmDisablePgvector, setConfirmDisablePgvector] = useState(false);

  async function handlePgvectorChange(enabled: boolean) {
    setPgvectorSaving(true);
    try {
      await apiRequest(extensionsPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "vector", enabled }),
      });
      nanogresToast.success(enabled ? "pgvector enabled for this database" : "pgvector disabled");
      await extensionsQuery.refresh();
    } catch (err) {
      nanogresToast.error(err instanceof Error ? err.message : "Could not update pgvector.");
    } finally {
      setPgvectorSaving(false);
    }
  }

  return (
    <DatabaseTabPanel tab="extensions">
      <Notice tone="info">
        The pgvector package is installed once for the PostgreSQL server. Enabling it here applies
        only to “{databaseName}”.
      </Notice>
      <ErrorNotice error={extensionsQuery.error} onRetry={() => void extensionsQuery.refresh()} />
      {extensionsQuery.loading && !pgvector ? (
        <Loading label="Checking PostgreSQL extensions..." />
      ) : null}
      {pgvector ? (
        <Panel title="pgvector" detail="Vector types and similarity search for this database">
          <div className={styles.extensionRow}>
            <div className={styles.extensionDetails}>
              <span
                className={`${styles.extensionStatus} ${pgvector.enabled ? styles.extensionStatusEnabled : styles.extensionStatusDisabled}`}
              >
                {pgvector.enabled
                  ? `Enabled${pgvector.version ? ` · v${pgvector.version}` : ""}`
                  : "Disabled"}
              </span>
              <p className={styles.extensionDescription}>
                Adds the <code>vector</code> and <code>halfvec</code> types, similarity operators,
                and HNSW indexes.
              </p>
            </div>
            <Button
              disabled={pgvectorSaving || (!pgvector.available && !pgvector.enabled)}
              onClick={() => {
                if (pgvector.enabled) setConfirmDisablePgvector(true);
                else void handlePgvectorChange(true);
              }}
              variant={pgvector.enabled ? "secondary" : "primary"}
            >
              {pgvectorSaving
                ? "Saving…"
                : pgvector.enabled
                  ? "Disable pgvector"
                  : "Enable pgvector"}
            </Button>
          </div>
          {!pgvector.available ? (
            <div className={styles.extensionNotice}>
              <Notice tone="warning">
                The pgvector package is not installed for this PostgreSQL server version. Ask a
                server administrator to install it before enabling the extension.
              </Notice>
            </div>
          ) : null}
        </Panel>
      ) : null}
      {!extensionsQuery.loading && !extensionsQuery.error && !pgvector ? (
        <Empty>Nanogres did not return an extension status.</Empty>
      ) : null}
      {confirmDisablePgvector ? (
        <ConfirmDialog
          title="Disable pgvector?"
          confirmLabel="Disable extension"
          message="This removes pgvector from this database. PostgreSQL will refuse if tables, indexes, or other objects depend on it; Nanogres will not cascade-drop those objects."
          onCancel={() => setConfirmDisablePgvector(false)}
          onConfirm={() => {
            setConfirmDisablePgvector(false);
            void handlePgvectorChange(false);
          }}
        />
      ) : null}
    </DatabaseTabPanel>
  );
}
