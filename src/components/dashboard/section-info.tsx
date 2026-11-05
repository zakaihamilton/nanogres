import { useId } from "react";
import styles from "./section-info.module.css";

export function SectionInfo({ label }: { label: string }) {
  const tooltipId = useId();

  return (
    <span className={styles.wrapper}>
      <button
        aria-describedby={tooltipId}
        aria-label="Section information"
        className={styles.button}
        type="button"
      >
        <svg
          aria-hidden="true"
          fill="none"
          height="15"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
          viewBox="0 0 24 24"
          width="15"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <circle cx="12" cy="8" r=".75" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <span className={styles.tooltip} id={tooltipId} role="tooltip">
        {label}
      </span>
    </span>
  );
}
