"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "./icons";
import styles from "./organization-switcher.module.css";

export type OrganizationItem = {
  organizationId: string;
  organizationName: string;
  role: string;
};

function OrganizationSummary({ name, detail }: { name: string; detail: string }) {
  return (
    <>
      <span className={styles.iconWrap}>
        <Icon name="server" size={16} />
      </span>
      <span className={styles.textGroup}>
        <strong className={styles.organizationName}>{name}</strong>
        <small className={styles.productLabel}>{detail}</small>
      </span>
    </>
  );
}

export function OrganizationSwitcher({
  currentOrganizationId,
  currentOrganizationName,
  organizations = [],
  preview = false,
}: {
  currentOrganizationId?: string;
  currentOrganizationName?: string;
  organizations?: OrganizationItem[];
  preview?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fallbackId = currentOrganizationId ?? (preview ? "org-demo" : "");
  const fallbackName = currentOrganizationName ?? (preview ? "Example organization" : "");
  const choices = organizations.length
    ? organizations
    : fallbackId
      ? [{ organizationId: fallbackId, organizationName: fallbackName, role: "admin" }]
      : [];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!fallbackId) {
    return (
      <div aria-label="No organization access" className={styles.trigger}>
        <OrganizationSummary
          detail="Ask a Perminister admin for access"
          name="No organization access"
        />
      </div>
    );
  }

  async function selectOrganization(organizationId: string) {
    if (organizationId === fallbackId) {
      setOpen(false);
      return;
    }
    if (preview) {
      setOpen(false);
      return;
    }
    setError(null);
    try {
      const response = await fetch("/api/organizations/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null);
        const message =
          typeof result === "object" &&
          result !== null &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "The organization could not be selected.";
        setError(message);
        return;
      }
      router.push("/overview");
    } catch {
      setError("The organization could not be selected. Try again.");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") setOpen(false);
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleKeyDown}
        type="button"
      >
        <OrganizationSummary detail="Organization databases" name={fallbackName} />
        <svg
          aria-hidden="true"
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="m6 9 6 6 6-6"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        </svg>
      </button>
      {open ? (
        <div aria-label="Organizations" className={styles.menu} role="listbox">
          <div className={styles.menuHeader}>Organizations ({choices.length})</div>
          {choices.map((organization) => {
            const selected = organization.organizationId === fallbackId;
            return (
              <button
                aria-selected={selected}
                className={`${styles.option} ${selected ? styles.optionSelected : ""}`}
                key={organization.organizationId}
                onClick={() => void selectOrganization(organization.organizationId)}
                role="option"
                type="button"
              >
                <span className={styles.optionText}>
                  <span className={styles.optionName}>{organization.organizationName}</span>
                  <span className={styles.optionMeta}>Organization database access</span>
                </span>
                <span className={styles.optionBadges}>
                  <span className={styles.optionRole}>{organization.role}</span>
                  {selected ? <Icon name="check" size={15} /> : null}
                </span>
              </button>
            );
          })}
          <div className={styles.menuDivider} />
          <Link
            className={styles.manageOrganizationsAction}
            href="/organizations"
            onClick={() => setOpen(false)}
          >
            <Icon name="server" size={14} />
            <span>Organization access</span>
          </Link>
          {error ? (
            <div className={styles.error} role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
