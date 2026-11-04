import type { ReactNode } from "react";
import styles from "./tooltip.module.css";

export function Tooltip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span className={styles.tooltip}>
      {children}
      <span aria-hidden="true" className={styles.label}>
        {label}
      </span>
    </span>
  );
}
