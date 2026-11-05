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
  onNavigate,
  previewMode = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  databases?: string[];
  onNavigate?: (href: string) => void;
  previewMode?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const overlay = overlayRef.current;
    const palette = paletteRef.current;
    const list = listRef.current;
    if (!overlay || !palette || !list) return;

    const containWheel = (event: WheelEvent) => {
      if (!palette.contains(event.target as Node)) {
        event.preventDefault();
        return;
      }

      if (!list.contains(event.target as Node)) {
        const deltaY =
          event.deltaY *
          (event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? list.clientHeight
              : 1);
        list.scrollTop += deltaY;
        event.preventDefault();
        return;
      }

      const maxScrollTop = list.scrollHeight - list.clientHeight;
      const atTop = list.scrollTop <= 0;
      const atBottom = list.scrollTop >= maxScrollTop;

      if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
        event.preventDefault();
      }
    };

    overlay.addEventListener("wheel", containWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", containWheel);
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setQuery("");
    setSelectedIndex(0);
    onClose();
  }, [onClose]);

  const navigate = useCallback(
    (href: string) => {
      handleClose();
      if (onNavigate) onNavigate(href);
      else router.push(href);
    },
    [handleClose, onNavigate, router],
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

  const allItems = (previewMode
    ? baseItems.filter((item) => item.id !== "nav-sql")
    : [...baseItems, ...dbItems]
  ).sort((a, b) => a.label.localeCompare(b.label));

  const filteredItems = query.trim()
    ? allItems.filter(
        (item) =>
          item.label.toLowerCase().includes(query.trim().toLowerCase()) ||
          item.group.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : allItems;

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

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
    <div className={styles.overlay} ref={overlayRef}>
      <button
        aria-label="Close command palette overlay"
        className={styles.backdrop}
        onClick={handleClose}
        type="button"
      />
      <div
        aria-label="Command palette"
        aria-modal="true"
        className={styles.palette}
        ref={paletteRef}
        role="dialog"
      >
        <div className={styles.inputWrap}>
          <span className={styles.searchIcon}>
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            aria-activedescendant={
              filteredItems[selectedIndex]
                ? `command-${filteredItems[selectedIndex].id}`
                : undefined
            }
            aria-label="Search pages, databases, and actions"
            aria-controls="command-list"
            aria-expanded="true"
            aria-haspopup="listbox"
            className={styles.input}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command, database name, or page..."
            role="combobox"
            value={query}
          />
          <kbd className={styles.shortcut}>ESC</kbd>
        </div>

        <ul
          aria-label="Commands"
          className={styles.list}
          id="command-list"
          ref={listRef}
          role="listbox"
        >
          {filteredItems.length === 0 ? (
            <li className={styles.empty}>No commands or databases found</li>
          ) : (
            filteredItems.map((item, index) => {
              const isSelected = index === selectedIndex;
              return (
                <li key={item.id} role="presentation">
                  <button
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    aria-selected={isSelected}
                    className={`${styles.item} ${isSelected ? styles.itemSelected : ""}`}
                    onClick={() => item.onSelect()}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setSelectedIndex(index)}
                    id={`command-${item.id}`}
                    role="option"
                    tabIndex={-1}
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
