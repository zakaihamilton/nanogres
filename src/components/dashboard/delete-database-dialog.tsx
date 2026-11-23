"use client";

import { AlertDialog } from "panel-frame-ui";
import { type FormEvent, useRef, useState } from "react";
import { TENANT_NAME_MAX_LENGTH } from "@/lib/tenant-names";
import styles from "./delete-dialog.module.css";
import type { Database } from "./live-api";
import { Button } from "./live-primitives";

export function DeleteDatabaseDialog({
  database,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  database: Database;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  async function copyDatabaseName() {
    try {
      await navigator.clipboard.writeText(database.name);
      setCopyStatus("Database name copied.");
    } catch {
      setCopyStatus("Could not copy. Select the name and copy it manually.");
    }
  }

  function confirmDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || confirmationName !== database.name) return;
    onConfirm();
  }

  return (
    <AlertDialog
      aria-busy={busy}
      className={styles.dialog}
      description="This permanently deletes the database and all of its data. This cannot be undone."
      initialFocusRef={nameInputRef}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      open
      title="Delete database?"
    >
      <div className={styles.dialogContent}>
        <p className={styles.dialogEyebrow}>DESTRUCTIVE ACTION</p>
        <div className={styles.dialogNameGroup}>
          <span className={styles.dialogNameLabel}>Database name</span>
          <div className={styles.dialogNameRow}>
            <code className={styles.dialogDatabaseName}>{database.name}</code>
            <Button disabled={busy} onClick={() => void copyDatabaseName()} variant="secondary">
              Copy name
            </Button>
          </div>
          <span aria-live="polite" className={styles.dialogStatus} role="status">
            {copyStatus}
          </span>
        </div>
        <form className={styles.dialogForm} onSubmit={confirmDeletion}>
          <label htmlFor="delete-database-confirmation">
            Type the database name exactly to enable deletion.
          </label>
          <input
            autoCapitalize="off"
            autoComplete="off"
            disabled={busy}
            id="delete-database-confirmation"
            maxLength={TENANT_NAME_MAX_LENGTH}
            onChange={(event) => setConfirmationName(event.target.value)}
            placeholder="Type the database name"
            ref={nameInputRef}
            required
            spellCheck={false}
            value={confirmationName}
          />
          {error ? (
            <p className={styles.dialogError} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.dialogActions}>
            <Button disabled={busy} onClick={onCancel} variant="secondary">
              Cancel
            </Button>
            <Button
              disabled={busy || confirmationName !== database.name}
              type="submit"
              variant="danger"
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
          </div>
        </form>
      </div>
    </AlertDialog>
  );
}
