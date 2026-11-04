"use client";

import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from "react";
import styles from "./toast.module.css";

export type ToastType = "success" | "error" | "info";

export type Toast = {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  duration?: number;
};

type ToastContextValue = {
  showToast: (toast: Omit<Toast, "id">) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

let globalShowToast: ((toast: Omit<Toast, "id">) => void) | null = null;

export const nanogresToast = {
  success(message: string, title?: string) {
    globalShowToast?.({ type: "success", message, title });
  },
  error(message: string, title?: string) {
    globalShowToast?.({ type: "error", message, title });
  },
  info(message: string, title?: string) {
    globalShowToast?.({ type: "info", message, title });
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    ({ type, title, message, duration = 4500 }: Omit<Toast, "id">) => {
      const id = Math.random().toString(36).substring(2, 9);
      setToasts((prev) => [...prev, { id, type, title, message, duration }]);

      if (duration > 0) {
        setTimeout(() => {
          dismiss(id);
        }, duration);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    globalShowToast = showToast;
    return () => {
      globalShowToast = null;
    };
  }, [showToast]);

  const success = useCallback(
    (message: string, title?: string) => showToast({ type: "success", message, title }),
    [showToast],
  );

  const error = useCallback(
    (message: string, title?: string) => showToast({ type: "error", message, title }),
    [showToast],
  );

  const info = useCallback(
    (message: string, title?: string) => showToast({ type: "info", message, title }),
    [showToast],
  );

  return (
    <ToastContext.Provider value={{ showToast, success, error, info, dismiss }}>
      {children}
      <aside aria-label="Notifications" className={styles.toastViewport}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            aria-live="polite"
            className={`${styles.toast} ${
              toast.type === "success"
                ? styles.toastSuccess
                : toast.type === "error"
                  ? styles.toastError
                  : styles.toastInfo
            }`}
            role="status"
          >
            <div className={styles.toastContent}>
              {toast.title ? <div className={styles.toastTitle}>{toast.title}</div> : null}
              <div className={styles.toastMessage}>{toast.message}</div>
            </div>
            <button
              aria-label="Dismiss notification"
              className={styles.toastClose}
              onClick={() => dismiss(toast.id)}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </aside>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      showToast: () => {},
      success: (msg, title) => nanogresToast.success(msg, title),
      error: (msg, title) => nanogresToast.error(msg, title),
      info: (msg, title) => nanogresToast.info(msg, title),
      dismiss: () => {},
    };
  }
  return ctx;
}
