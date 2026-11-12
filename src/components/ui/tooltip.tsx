"use client";

import type { ReactNode } from "react";
import { Tooltip as PanelTooltip } from "panel-frame-ui";

export function Tooltip({
  children,
  label,
  placement = "top",
}: {
  children: ReactNode;
  label?: string;
  placement?: "top" | "bottom";
}) {
  if (!label) return <>{children}</>;
  return (
    <PanelTooltip content={label} placement={placement}>
      {children}
    </PanelTooltip>
  );
}
