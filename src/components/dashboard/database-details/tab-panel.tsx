// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Tab panels are keyboard-focusable by the ARIA tabs pattern.
import type { ReactNode } from "react";
import type { Tab } from "./types";

export function DatabaseTabPanel({
  tab,
  gap = 14,
  children,
}: {
  tab: Tab;
  gap?: number;
  children: ReactNode;
}) {
  return (
    <div
      aria-labelledby={`database-tab-${tab}`}
      id="database-panel"
      role="tabpanel"
      style={{ display: "flex", flexDirection: "column", gap }}
      tabIndex={0}
    >
      {children}
    </div>
  );
}
