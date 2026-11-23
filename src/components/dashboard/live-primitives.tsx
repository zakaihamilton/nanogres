"use client";

import Link from "next/link";
import { Button as PanelButton, PageHeader as PanelPageHeader } from "panel-frame-ui";
import type { ReactNode } from "react";
import { type ActivityEvent, formatDate } from "./live-api";
import styles from "./live-primitives.module.css";
import { PanelFrame } from "./panel-frame";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <PanelPageHeader actions={action} description={description} eyebrow={eyebrow} title={title} />
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className={styles.primaryButton} href={href}>
      {children}
    </Link>
  );
}

export function Button({
  children,
  disabled = false,
  onClick,
  ariaLabel,
  variant = "primary",
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
}) {
  return (
    <PanelButton
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      type={type}
      variant={variant}
    >
      {children}
    </PanelButton>
  );
}

export function Panel({
  title,
  detail,
  info,
  children,
}: {
  title: string;
  detail?: string;
  info?: string;
  children: ReactNode;
}) {
  return (
    <PanelFrame
      className={styles.panel}
      headingClassName={styles.panelHeader}
      title={title}
      detail={detail}
      info={info}
    >
      {children}
    </PanelFrame>
  );
}

export function Notice({
  children,
  tone = "error",
}: {
  children: ReactNode;
  tone?: "error" | "info" | "warning";
}) {
  return (
    <div
      className={`${styles.notice} ${styles[tone]}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function Loading({ label = "Loading server data…" }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function ErrorNotice({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  const permissionDenied =
    error === "Perminister denied this action." || error.includes("no Nanogres database access");
  return (
    <Notice>
      <span>
        {permissionDenied
          ? "Perminister denied this action. Ask an organization admin to grant Nanogres database access at organization scope."
          : error}
      </span>
      {onRetry ? (
        <Button onClick={onRetry} variant="secondary">
          Try again
        </Button>
      ) : null}
    </Notice>
  );
}

export function ActivityList({
  events,
  loading,
  error,
}: {
  events: ActivityEvent[];
  loading: boolean;
  error: string | null;
}) {
  if (loading && !events.length) return <Loading />;
  if (error && !events.length) {
    return <Empty>Nanogres could not load activity. Use Try again above to retry.</Empty>;
  }
  if (!events.length) return <Empty>No Nanogres operations recorded yet.</Empty>;
  return (
    <div className={styles.activityList}>
      {events.map((event, index) => (
        <div className={styles.activityItem} key={`${event.createdAt}-${index}`}>
          <span className={styles.activityMark} aria-hidden="true" />
          <div>
            <strong>{event.action.replaceAll(".", " ")}</strong>
            <p>
              {event.detail}
              {event.actor ? ` · actor ${event.actor}` : ""}
            </p>
          </div>
          <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
        </div>
      ))}
    </div>
  );
}
