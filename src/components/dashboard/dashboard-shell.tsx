"use client";

import Image from "next/image";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, type ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { ThemeControl } from "@/components/theme/theme-control";
import { ToastProvider } from "@/components/ui/toast";
import { CommandPalette } from "@/components/ui/command-palette";
import { Icon, type IconName } from "./icons";
import { WorkspaceSwitcher, type WorkspaceItem } from "./workspace-switcher";
import styles from "./dashboard-shell.module.css";

type AccountView = {
  name: string;
  email: string;
};

type NavigationItem = {
  label: string;
  href: string;
  icon: IconName;
};

const navigation: NavigationItem[] = [
  { label: "Overview", href: "/overview", icon: "overview" },
  { label: "Databases", href: "/databases", icon: "database" },
  { label: "SQL Editor", href: "/sql", icon: "sql" },
  { label: "Access & roles", href: "/access", icon: "access" },
  { label: "Backups", href: "/backups", icon: "backup" },
  { label: "Activity", href: "/activity", icon: "activity" },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function isActive(pathname: string, item: NavigationItem, activePath?: string): boolean {
  const path = activePath ?? pathname;
  return item.href === "/overview"
    ? path === "/overview"
    : path === item.href || path.startsWith(`${item.href}/`);
}

function getBreadcrumbs(pathname: string): { label: string; href?: string }[] {
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length || parts[0] === "overview") {
    return [{ label: "OVERVIEW" }];
  }
  const crumbs: { label: string; href?: string }[] = [];
  if (parts[0] === "databases") {
    crumbs.push({ label: "DATABASES", href: "/databases" });
    if (parts[1] === "new") {
      crumbs.push({ label: "NEW" });
    } else if (parts[1]) {
      crumbs.push({ label: decodeURIComponent(parts[1]).toUpperCase() });
    }
  } else if (parts[0] === "sql") {
    crumbs.push({ label: "SQL STUDIO" });
  } else if (parts[0] === "access") {
    crumbs.push({ label: "ACCESS & ROLES", href: "/access" });
    if (parts[1] === "new") crumbs.push({ label: "NEW ROLE" });
  } else if (parts[0] === "backups") {
    crumbs.push({ label: "BACKUPS", href: "/backups" });
    if (parts[1] === "new") crumbs.push({ label: "NEW BACKUP" });
    if (parts[1] === "restore") crumbs.push({ label: "RESTORE" });
  } else if (parts[0] === "activity") {
    crumbs.push({ label: "ACTIVITY" });
  } else if (parts[0] === "workspaces") {
    crumbs.push({ label: "WORKSPACES" });
  } else {
    crumbs.push({ label: parts[0].toUpperCase() });
  }
  return crumbs;
}

export function DashboardShell({
  account,
  currentWorkspace,
  currentOrganization,
  workspaces,
  children,
  previewMode = false,
  activePath,
  onPreviewNavigate,
}: {
  account: AccountView;
  currentWorkspace?: { id: string; name: string };
  currentOrganization?: { id: string; name: string };
  workspaces?: WorkspaceItem[];
  children: ReactNode;
  previewMode?: boolean;
  activePath?: string;
  onPreviewNavigate?: (path: string) => void;
}) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [databaseNames, setDatabaseNames] = useState<string[]>(() =>
    previewMode ? ["app_main", "event_store", "sandbox"] : [],
  );
  const breadcrumbs = getBreadcrumbs(activePath ?? pathname);

  useEffect(() => {
    if (previewMode) return;
    fetch("/api/nanogres/databases")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.databases && Array.isArray(d.databases)) {
          setDatabaseNames(d.databases.map((db: { name: string }) => db.name));
        }
      })
      .catch(() => {
        // ignore
      });
  }, [previewMode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <ToastProvider>
      <div className={styles.frame}>
        <a className={styles.skipLink} href="#main-content">
          Skip to main content
        </a>
        <aside aria-label="Main navigation" className={styles.sidebar}>
          <Link
            aria-label="Nanogres overview"
            className={styles.brand}
            href="/overview"
            onClick={
              previewMode
                ? (event) => {
                    event.preventDefault();
                    onPreviewNavigate?.("/overview");
                  }
                : undefined
            }
          >
            <Image alt="" className={styles.brandMark} src="/icon.svg" width={32} height={32} />
            <span className={styles.brandName}>nanogres</span>
          </Link>

          <WorkspaceSwitcher
            currentWorkspaceId={currentWorkspace?.id}
            currentWorkspaceName={currentWorkspace?.name}
            currentOrganizationName={currentOrganization?.name}
            preview={previewMode}
            workspaces={workspaces}
          />

          <p className={styles.sectionLabel}>Manage</p>
          <nav className={styles.navigation}>
            {navigation
              .filter((item) => !previewMode || item.href !== "/sql")
              .map((item) => {
                const active = isActive(pathname, item, activePath);
                return (
                  <Link
                    aria-label={
                      previewMode && item.href === "/databases"
                        ? `Databases, ${databaseNames.length} managed databases`
                        : undefined
                    }
                    aria-current={active ? "page" : undefined}
                    aria-disabled={(previewMode && !onPreviewNavigate) || undefined}
                    className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                    href={item.href}
                    onClick={
                      previewMode
                        ? (event) => {
                            event.preventDefault();
                            onPreviewNavigate?.(item.href);
                          }
                        : undefined
                    }
                    key={item.href}
                  >
                    <Icon name={item.icon} size={18} />
                    <span>{item.label}</span>
                    {item.href === "/databases" && previewMode ? (
                      <span aria-hidden="true" className={styles.navCount}>
                        {databaseNames.length}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
          </nav>

          <div className={styles.sidebarSpacer} />
          <div className={styles.sidebarStatus}>
            <span className={styles.statusDot} />
            <span>
              <strong>{previewMode ? "Preview mode" : "Perminister session"}</strong>
              <small>{previewMode ? "Synthetic data only" : "Access checked per action"}</small>
            </span>
          </div>
          <div className={styles.profile}>
            <span aria-hidden="true" className={styles.avatar}>
              {initials(account.name) || "N"}
            </span>
            <span className={styles.profileText}>
              <strong>{account.name}</strong>
              <small>{account.email}</small>
            </span>
            {!previewMode ? (
              <form action="/api/auth/logout" method="post">
                <Tooltip label="Sign out">
                  <button aria-label="Sign out" className={styles.signOut} type="submit">
                    ↗
                  </button>
                </Tooltip>
              </form>
            ) : (
              <span aria-label="Preview only" className={styles.previewUserMark} role="img">
                <Icon name="sparkle" size={16} />
              </span>
            )}
          </div>
        </aside>

        <div className={styles.mainPanel}>
          <header className={styles.topbar}>
            <div className={styles.breadcrumbs}>
              <Link className={styles.crumbLink} href="/overview">
                {currentWorkspace?.name ? currentWorkspace.name.toUpperCase() : "WORKSPACE"}
              </Link>
              {breadcrumbs.map((crumb, idx) => (
                <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                  <span aria-hidden="true" className={styles.crumbSep}>
                    /
                  </span>
                  {crumb.href && idx < breadcrumbs.length - 1 ? (
                    <Link className={styles.crumbLink} href={crumb.href}>
                      {crumb.label}
                    </Link>
                  ) : (
                    <strong>{crumb.label}</strong>
                  )}
                </span>
              ))}
              {previewMode ? <span className={styles.previewTag}>UI PREVIEW</span> : null}
            </div>
            <div className={styles.topbarActions}>
              <button
                className={styles.searchTrigger}
                onClick={() => setPaletteOpen(true)}
                type="button"
                aria-label="Open command palette (Cmd+K)"
              >
                <Icon name="search" size={14} />
                <span>Commands</span>
                <kbd className={styles.cmdKey}>⌘K</kbd>
              </button>
              <div className={styles.apiStatus}>
                <Icon name="shield" size={15} />
                {previewMode ? "Preview data" : "Authorized session"}
              </div>
              {!previewMode ? <ThemeControl /> : null}
            </div>
          </header>
          <main className={styles.mainContent} id="main-content" tabIndex={-1}>
            {children}
          </main>
          <footer className={styles.footer}>
            <span>Nanogres</span>
            <span>PostgreSQL cluster manager</span>
          </footer>
        </div>
      </div>
      <CommandPalette
        databases={databaseNames}
        isOpen={paletteOpen}
        onNavigate={previewMode ? onPreviewNavigate : undefined}
        onClose={() => setPaletteOpen(false)}
        previewMode={previewMode}
      />
    </ToastProvider>
  );
}
