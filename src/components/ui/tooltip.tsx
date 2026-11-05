import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import styles from "./tooltip.module.css";

type TooltipTargetProps = {
  "aria-describedby"?: string;
};

export function Tooltip({ children, label }: { children: ReactNode; label?: string }) {
  const tooltipId = useId();
  if (!label) return <>{children}</>;

  const target = isValidElement<TooltipTargetProps>(children)
    ? cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], tooltipId]
          .filter(Boolean)
          .join(" "),
      })
    : children;

  return (
    <span className={styles.tooltip}>
      {target}
      <span className={styles.label} id={tooltipId} role="tooltip">
        {label}
      </span>
    </span>
  );
}
