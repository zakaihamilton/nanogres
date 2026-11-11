"use client";

import Image from "next/image";
import { DashboardShell as PanelFrameDashboardShell } from "panel-frame-ui";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, type MouseEvent, type ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { ThemeControl } from "@/components/theme/theme-control";
import { ToastProvider } from "@/components/ui/toast";
import { CommandPalette } from "@/components/ui/command-palette";
import { Icon, type IconName } from "./icons";
import { OrganizationSwitcher, type OrganizationItem } from "./organization-switcher";
import styles from "./dashboard-shell.module.css";

type AccountView = {
  name: string;
  email?: string | null;
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
    if (parts[1] === "transfers") crumbs.push({ label: "TRANSFERS" });
  } else if (parts[0] === "activity") {
    crumbs.push({ label: "ACTIVITY" });
  } else if (parts[0] === "organizations") {
    crumbs.push({ label: "ORGANIZATIONS" });
  } else {
    crumbs.push({ label: parts[0].toUpperCase() });
  }
  return crumbs;
}

export function DashboardShell({
  account,
  currentOrganization,
  organizations,
  children,
  previewMode = false,
  activePath,
  onPreviewNavigate,
}: {
  account: AccountView;
  currentOrganization?: { id: string; name: string };
  organizations?: OrganizationItem[];
  children: ReactNode;
  previewMode?: boolean;
  activePath?: string;
  onPreviewNavigate?: (path: string) => void;
}) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [databaseNames, setDatabaseNames] = useState<string[]>(() =>
    previewMode ? ["app_main", "event_store", "sandbox"] : [],
  );
  const breadcrumbs = getBreadcrumbs(activePath ?? pathname);

  function handleBreadcrumbNavigate(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (!previewMode || !onPreviewNavigate) return;
    event.preventDefault();
    onPreviewNavigate(href);
  }

  useEffect(() => {
    if (previewMode) return;
    fetch("/api/nanogres/databases")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.databases && Array.isArray(data.databases)) {
          setDatabaseNames(data.databases.map((database: { name: string }) => database.name));
        }
      })
      .catch(() => {
        // Ignore unavailable database metadata.
      });
  }, [previewMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((previous) => !previous);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <ToastProvider>
      <PanelFrameDashboardShell
        brand={
          <Link
            aria-label="Nanogres overview"
            className="pf-brand"
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
            <Image alt="" className={styles.brandMark} src="/brand-icon.png" width={32} height={32} />
            <span className={styles.brandName}>nanogres</span>
          </Link>
        }
        sidebarContext={
          <OrganizationSwitcher
            currentOrganizationId={currentOrganization?.id}
            currentOrganizationName={currentOrganization?.name}
            preview={previewMode}
            organizations={organizations}
          />
        }
        navigation={
          <div className="pf-sidebar-group">
            <p className="pf-sidebar-group-label">Manage</p>
            <nav aria-label="Main navigation">
              {navigation
                .filter((item) => !previewMode || item.href !== "/sql")
                .map((item) => {
                  const active = isActive(pathname, item, activePath);
                  return (
                    <Link
                      aria-current={active ? "page" : undefined}
                      aria-disabled={(previewMode && !onPreviewNavigate) || undefined}
                      className="pf-sidebar-link"
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
          </div>
        }
        sidebarVisible={sidebarVisible}
        sidebarFooter={
          <>
            {previewMode ? (
              <div className={styles.sidebarStatus}>
                <span className={styles.statusDot} />
                <span>
                  <strong>Preview mode</strong>
                  <small>Synthetic data only</small>
                </span>
              </div>
            ) : null}
            <div className={styles.profile}>
              <span aria-hidden="true" className={styles.avatar}>
                {initials(account.name) || "N"}
              </span>
              <span className={styles.profileText}>
                <strong>{account.name}</strong>
                {account.email ? <small>{account.email}</small> : null}
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
          </>
        }
        toolbar={
          <>
            <div className={styles.topbarStart}>
              <Tooltip
                label={sidebarVisible ? "Collapse sidebar" : "Expand sidebar"}
                placement="bottom"
              >
                <button
                  aria-controls="pf-dashboard-sidebar"
                  aria-expanded={sidebarVisible}
                  aria-label={
                    sidebarVisible ? "Collapse navigation sidebar" : "Expand navigation sidebar"
                  }
                  className={styles.sidebarToggle}
                  onClick={() => setSidebarVisible((visible) => !visible)}
                  type="button"
                >
                  <Icon name={sidebarVisible ? "sidebarCollapse" : "sidebarExpand"} size={18} />
                </button>
              </Tooltip>
              <div className={styles.breadcrumbs}>
                <Tooltip label="Go to overview" placement="bottom">
                  <Link
                    className={styles.crumbLink}
                    href="/overview"
                    onClick={(event) => handleBreadcrumbNavigate(event, "/overview")}
                  >
                    {currentOrganization?.name
                      ? currentOrganization.name.toUpperCase()
                      : "ORGANIZATION"}
                  </Link>
                </Tooltip>
                {breadcrumbs.map((crumb, index) => (
                  <span
                    key={index}
                    style={{ display: "inline-flex", alignItems: "center", gap: 9 }}
                  >
                    <span aria-hidden="true" className={styles.crumbSep}>
                      /
                    </span>
                    {crumb.href && index < breadcrumbs.length - 1 ? (
                      <Tooltip label={"Go to " + crumb.label.toLowerCase()} placement="bottom">
                        <Link
                          className={styles.crumbLink}
                          href={crumb.href}
                          onClick={(event) => handleBreadcrumbNavigate(event, crumb.href!)}
                        >
                          {crumb.label}
                        </Link>
                      </Tooltip>
                    ) : (
                      <strong>{crumb.label}</strong>
                    )}
                  </span>
                ))}
                {previewMode ? <span className={styles.previewTag}>UI PREVIEW</span> : null}
              </div>
            </div>
            <div className={styles.topbarActions}>
              <button
                aria-label="Search commands"
                className={styles.searchTrigger}
                onClick={() => setPaletteOpen(true)}
                type="button"
              >
                <Icon name="search" size={14} />
                <span>Commands</span>
                <kbd className={styles.cmdKey}>⌘K</kbd>
              </button>
              {!previewMode ? <ThemeControl /> : null}
            </div>
          </>
        }
      >
        {children}
      </PanelFrameDashboardShell>
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
