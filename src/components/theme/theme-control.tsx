"use client";

import { useSyncExternalStore } from "react";
import styles from "./theme-control.module.css";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

const labels: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function readTheme(): Theme {
  const current = document.documentElement.dataset.theme;
  return current === "system" || current === "light" || current === "dark" ? current : "system";
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function getServerTheme(): Theme {
  return "system";
}

export function ThemeControl() {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, getServerTheme);

  function updateTheme(next: Theme) {
    document.documentElement.dataset.theme = next;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }

  return (
    <label className={styles.control}>
      <span className={styles.label}>Theme</span>
      <select
        aria-label="Color theme"
        className={styles.select}
        onChange={(event) => updateTheme(event.target.value as Theme)}
        value={theme}
      >
        {Object.entries(labels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
