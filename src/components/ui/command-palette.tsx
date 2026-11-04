"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/dashboard/icons";
import styles from "./command-palette.module.css";

export type PaletteItem = {
  id: string;
  label: string;
  group: "Navigation" | "Databases" | "Actions";
  icon: "overview" | "database" | "sql" | "access" | "backup" | "activity" | "plus" | "server";
  badge?: string;
  onSelect: () => void;
};

export function CommandPalette({
  isOpen,
  onClose,
  databases = [],
}: {
  isOpen: boolean;
  onClose: () => void;
  databases?: string[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setQuery("");
    setSelectedIndex(0);
    onClose();
  }, [onClose]);

  const navigate = useCallback(
    (href: string) => {
      handleClose();
      router.push(href);
    },
    [handleClose, router],
  );

  const baseItems: PaletteItem[] = [
    {
      id: "nav-overview",
      label: "Overview",
      group: "Navigation",
      icon: "overview",
      badge: "Go to page",
      onSelect: () => navigate("/overview"),
    },
    {
      id: "nav-databases",
      label: "Databases Fleet",
      group: "Navigation",
      icon: "database",
      badge: "Go to page",
      onSelect: () => navigate("/databases"),
    },
    {
      id: "nav-sql",
      label: "SQL Editor",
      group: "Navigation",
      icon: "sql",
      badge: "Go to page",
      onSelect: () => navigate("/sql"),
    },
    {
      id: "nav-access",
      label: "Access & Roles",
      group: "Navigation",
      icon: "access",
      badge: "Go to page",
      onSelect: () => navigate("/access"),
    },
    {
      id: "nav-backups",
      label: "Backups",
      group: "Navigation",
      icon: "backup",
      badge: "Go to page",
      onSelect: () => navigate("/backups"),
    },
    {
      id: "nav-activity",
      label: "Activity & Audit Trail",
      group: "Navigation",
      icon: "activity",
      badge: "Go to page",
      onSelect: () => navigate("/activity"),
    },
    {
      id: "act-create-db",
      label: "Create new database",
      group: "Actions",
      icon: "plus",
      badge: "Action",
      onSelect: () => navigate("/databases/new"),
    },
    {
      id: "act-create-role",
      label: "Create login role",
      group: "Actions",
      icon: "access",
      badge: "Action",
      onSelect: () => navigate("/access/new"),
    },
    {
      id: "act-create-backup",
      label: "Create manual backup",
      group: "Actions",
      icon: "backup",
      badge: "Action",
      onSelect: () => navigate("/backups/new"),
    },
  ];

  const dbItems: PaletteItem[] = databases.map((db) => ({
    id: `db-${db}`,
    label: db,
    group: "Databases",
    icon: "database",
    badge: "Database",
    onSelect: () => navigate(`/databases/${encodeURIComponent(db)}`),
  }));

  const allItems = [...baseItems, ...dbItems];

  const filteredItems = query.trim()
    ? allItems.filter(
        (item) =>
          item.label.toLowerCase().includes(query.trim().toLowerCase()) ||
          item.group.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : allItems;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(
        (prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        filteredItems[selectedIndex].onSelect();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay}>
      <button
        aria-label="Close command palette overlay"
        className={styles.backdrop}
        onClick={handleClose}
        type="button"
      />
      <div aria-label="Command palette" aria-modal="true" className={styles.palette} role="dialog">
        <div className={styles.inputWrap}>
          <span className={styles.searchIcon}>
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            aria-label="Search pages, databases, and actions"
            className={styles.input}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command, database name, or page..."
            value={query}
          />
          <kbd className={styles.shortcut}>ESC</kbd>
        </div>

        <ul className={styles.list} role="listbox">
          {filteredItems.length === 0 ? (
            <li className={styles.empty}>No commands or databases found</li>
          ) : (
            filteredItems.map((item, index) => {
              const isSelected = index === selectedIndex;
              return (
                <li key={item.id} role="option" aria-selected={isSelected}>
                  <button
                    className={`${styles.item} ${isSelected ? styles.itemSelected : ""}`}
                    onClick={() => item.onSelect()}
                    onMouseEnter={() => setSelectedIndex(index)}
                    style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
                    type="button"
                  >
                    <span className={styles.itemLeft}>
                      <span className={styles.itemIcon}>
                        <Icon name={item.icon} size={15} />
                      </span>
                      <span>{item.label}</span>
                    </span>
                    {item.badge ? <span className={styles.itemBadge}>{item.badge}</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
