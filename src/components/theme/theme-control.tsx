"use client";

import { ThemeControl as PanelThemeControl } from "panel-frame-ui";
import styles from "./theme-control.module.css";

export function ThemeControl() {
  return <PanelThemeControl className={styles.control} label="Theme" />;
}
