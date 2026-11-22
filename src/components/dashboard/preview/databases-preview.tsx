"use client";

import type { FormEvent } from "react";
import { TENANT_NAME_MAX_LENGTH, TENANT_NAME_PATTERN } from "@/lib/tenant-names";
import { Icon } from "../icons";
import { StorageCapacity } from "../storage-capacity";
import formStyles from "./forms-preview.module.css";
import { ApiNotice, DatabaseTable, EmptyState, Panel, ScreenHeading } from "./primitives";
import styles from "./primitives.module.css";
import {
  type DatabaseRow,
  databasesForScenario,
  diskForScenario,
  type PreviewScenario,
} from "./scenarios";

function DatabaseCreatePreviewForm({
  onSubmit,
  validationPreview = false,
}: {
  onSubmit?: (name: string) => void;
  validationPreview?: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = String(formData.get("database-name") ?? "");
    onSubmit?.(name);
    form.reset();
  }

  return (
    <form className={formStyles.createForm} onSubmit={submit}>
      <label htmlFor="preview-database-name">Database name</label>
      <div className={formStyles.createFormRow}>
        <input
          autoComplete="off"
          id="preview-database-name"
          maxLength={TENANT_NAME_MAX_LENGTH}
          minLength={2}
          name="database-name"
          pattern={TENANT_NAME_PATTERN}
          placeholder="my_project"
          defaultValue={validationPreview ? "Invalid Database Name!" : ""}
          aria-invalid={validationPreview || undefined}
          required
        />
        <button className={styles.primaryButton} disabled={!onSubmit} type="submit">
          Create database
        </button>
      </div>
    </form>
  );
}

export function DatabasesScreen({
  onPreviewDelete,
  onPreviewNavigate,
  previewPage = "list",
  onPreviewCreateDatabase,
  previewNotice,
  previewScenario = "healthy",
  readOnly = false,
  validationPreview = false,
}: {
  onPreviewDelete?: (database: DatabaseRow) => void;
  onPreviewNavigate?: (screen: string) => void;
  previewPage?: "list" | "new";
  onPreviewCreateDatabase?: (name: string) => void;
  previewNotice?: string | null;
  previewScenario?: PreviewScenario;
  readOnly?: boolean;
  validationPreview?: boolean;
}) {
  const connected = previewScenario !== "disconnected-server";
  const databases = databasesForScenario(previewScenario);
  const protectedDatabaseCount = databases.filter((database) => database.systemDatabase).length;
  const disk = diskForScenario(previewScenario);

  return (
    <div className={styles.screen}>
      <ScreenHeading
        action={previewPage === "list" && !readOnly && connected ? "Create a database" : undefined}
        description="Create databases and review size, owners, and active connections."
        eyebrow="DATA"
        title="Databases"
        onAction={readOnly ? undefined : () => onPreviewNavigate?.("database-new")}
      />
      {!connected ? <ApiNotice /> : null}
      {previewNotice ? (
        <div className={styles.previewNotice} role="status">
          {previewNotice}
        </div>
      ) : null}
      {previewPage === "new" ? (
        <Panel
          detail={`Lowercase letters, numbers, and underscores; max ${TENANT_NAME_MAX_LENGTH} characters.`}
          title="Create a database"
        >
          <DatabaseCreatePreviewForm
            onSubmit={readOnly ? undefined : onPreviewCreateDatabase}
            validationPreview={validationPreview}
          />
          {validationPreview ? (
            <div className={styles.previewNotice} role="alert">
              The database name must use lowercase letters, numbers, or underscores and be at least
              two characters long.
            </div>
          ) : null}
        </Panel>
      ) : (
        <>
          <Panel
            detail={
              connected
                ? `${databases.length} total · ${databases.filter((database) => !database.systemDatabase).length} managed · ${protectedDatabaseCount} protected system`
                : "Inventory unavailable until server connects"
            }
            title="All databases"
          >
            {!connected ? (
              <EmptyState
                description="Connect the VPS server to load its database inventory."
                title="Server connection pending"
              />
            ) : databases.length ? (
              <DatabaseTable
                rows={databases}
                variant="management"
                onDelete={readOnly ? undefined : onPreviewDelete}
              />
            ) : (
              <EmptyState
                description="Create a database to begin using this Postgres server."
                title="No databases yet"
              />
            )}
          </Panel>
          {connected ? (
            <Panel
              detail="Current VPS disk usage and per-database growth room"
              title="Storage capacity"
            >
              <StorageCapacity databases={databases} disk={disk} growthPercent={25} />
            </Panel>
          ) : null}
          <div className={styles.footerHint}>
            <Icon name="shield" size={15} />
            <span>Database operations will require an active Perminister grant.</span>
          </div>
        </>
      )}
    </div>
  );
}
