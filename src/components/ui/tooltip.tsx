"use client";

import { Tooltip as PanelTooltip } from "panel-frame-ui";
import type { ReactNode } from "react";

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
