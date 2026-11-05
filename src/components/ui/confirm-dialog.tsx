"use client";

import { useEffect, useRef } from "react";
import styles from "./controls.module.css";

export function ConfirmDialog({
  message,
  onCancel,
  onConfirm,
  title = "Confirm restore",
  confirmLabel = "Restore",
}: {
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  title?: string;
  confirmLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-message">{message}</p>
      <div className={styles.actions}>
        <button type="button" ref={cancelRef} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.confirm} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
