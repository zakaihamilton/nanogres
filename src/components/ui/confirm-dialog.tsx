"use client";

import { ConfirmDialog as PanelConfirmDialog } from "panel-frame-ui";

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
  return (
    <PanelConfirmDialog
      cancelLabel="Cancel"
      confirmLabel={confirmLabel}
      confirmVariant="primary"
      description={message}
      onConfirm={onConfirm}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
      title={title}
    />
  );
}
