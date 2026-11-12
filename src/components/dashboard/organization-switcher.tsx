"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ContextSwitcher } from "panel-frame-ui";
import { Icon } from "./icons";
import styles from "./organization-switcher.module.css";

export type OrganizationItem = {
  organizationId: string;
  organizationName: string;
  role: string;
};

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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fallbackId = currentOrganizationId ?? (preview ? "org-demo" : "");
  const fallbackName = currentOrganizationName ?? (preview ? "Example organization" : "");
  const choices = organizations.length
    ? organizations
    : fallbackId
      ? [{ organizationId: fallbackId, organizationName: fallbackName, role: "admin" }]
      : [];

  async function selectOrganization(organizationId: string) {
    if (organizationId === fallbackId || preview) return;
    setError(null);
    setPending(true);
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
    } finally {
      setPending(false);
    }
  }

  if (!fallbackId) {
    return (
      <div aria-label="No organization access" className={styles.trigger}>
        <span className={styles.iconWrap}>
          <Icon name="server" size={16} />
        </span>
        <span className={styles.textGroup}>
          <strong className={styles.organizationName}>No organization access</strong>
          <small className={styles.productLabel}>Ask a Perminister admin for access</small>
        </span>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <ContextSwitcher
        aria-label="Choose an organization"
        className={styles.contextSwitcher}
        disabled={pending}
        footer={
          <>
            {error ? <div role="alert">{error}</div> : null}
            <Link className="pf-select-footer-link" href="/organizations">
              <Icon name="server" size={14} /> Organization access
            </Link>
          </>
        }
        id="nanogres-organization-switcher"
        label="Organization"
        onValueChange={(value) => void selectOrganization(value)}
        options={choices.map((organization) => ({
          value: organization.organizationId,
          label: organization.organizationName,
          description: `${organization.role} · Organization databases`,
          icon: <Icon name="server" size={16} />,
        }))}
        value={fallbackId}
      />
    </div>
  );
}
