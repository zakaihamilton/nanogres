"use client";

import { useEffect, useRef } from "react";
import styles from "./controls.module.css";

export function ConfirmDialog({
  message,
  onCancel,
  onConfirm,
}: {
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
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
      <h2 id="confirm-title">Confirm restore</h2>
      <p id="confirm-message">{message}</p>
      <div className={styles.actions}>
        <button type="button" ref={cancelRef} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.confirm} onClick={onConfirm}>
          Restore
        </button>
      </div>
    </dialog>
  );
}
