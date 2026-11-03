"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeControl } from "@/components/theme/theme-control";
import { Icon, type IconName } from "./icons";
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
  { label: "Overview", href: "/", icon: "overview" },
  { label: "Databases", href: "/databases", icon: "database" },
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
  return item.href === "/" ? path === "/" : path === item.href || path.startsWith(`${item.href}/`);
}

export function DashboardShell({
  account,
  children,
  previewMode = false,
  activePath,
}: {
  account: AccountView;
  children: ReactNode;
  previewMode?: boolean;
  activePath?: string;
}) {
  const pathname = usePathname();

  return (
    <div className={styles.frame}>
      <aside aria-label="Main navigation" className={styles.sidebar}>
        <Link aria-label="Nanogres overview" className={styles.brand} href="/">
          <span aria-hidden="true" className={styles.brandMark}>
            <span />
            <span />
            <span />
          </span>
          <span className={styles.brandName}>nanogres</span>
        </Link>

        <div className={styles.workspaceCard}>
          <span className={styles.workspaceIcon}>
            <Icon name="server" size={16} />
          </span>
          <span className={styles.workspaceText}>
            <strong>Postgres workspace</strong>
            <small>VPS · private</small>
          </span>
          <span aria-hidden="true" className={styles.workspaceChevron}>
            ▾
          </span>
        </div>

        <p className={styles.sectionLabel}>Manage</p>
        <nav className={styles.navigation}>
          {navigation.map((item) => {
            const active = isActive(pathname, item, activePath);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                aria-disabled={previewMode || undefined}
                className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                href={item.href}
                onClick={previewMode ? (event) => event.preventDefault() : undefined}
                key={item.href}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
                {item.href === "/databases" && previewMode ? (
                  <span className={styles.navCount}>3</span>
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
              <button
                aria-label="Sign out"
                className={styles.signOut}
                title="Sign out"
                type="submit"
              >
                ↗
              </button>
            </form>
          ) : (
            <span aria-label="Preview only" className={styles.previewUserMark} title="Preview only">
              <Icon name="sparkle" size={16} />
            </span>
          )}
        </div>
      </aside>

      <div className={styles.mainPanel}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumbs}>
            <span>WORKSPACE</span>
            <span aria-hidden="true">/</span>
            <strong>POSTGRES</strong>
            {previewMode ? <span className={styles.previewTag}>UI PREVIEW</span> : null}
          </div>
          <div className={styles.topbarActions}>
            <div className={styles.apiStatus}>
              <span className={styles.statusDot} />
              {previewMode ? "Demo connection" : "Protected VPS API"}
            </div>
            <ThemeControl />
          </div>
        </header>
        <main className={styles.mainContent}>{children}</main>
        <footer className={styles.footer}>
          <span>Nanogres</span>
          <span>Postgres control plane</span>
        </footer>
      </div>
    </div>
  );
}
