"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "./icons";
import styles from "./workspace-switcher.module.css";

export type WorkspaceItem = {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  role?: string;
};

type Props = {
  currentWorkspaceId?: string;
  currentWorkspaceName?: string;
  currentOrganizationName?: string;
  workspaces?: WorkspaceItem[];
  preview?: boolean;
};

export function WorkspaceSwitcher({
  currentWorkspaceId = "vps-main",
  currentWorkspaceName = "Postgres workspace",
  currentOrganizationName = "Workspace cluster",
  workspaces = [],
  preview = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsId, setNewWsId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const choices: WorkspaceItem[] =
    workspaces.length > 0
      ? workspaces
      : [
          {
            id: currentWorkspaceId,
            name: currentWorkspaceName,
            organizationId: "org-main",
            organizationName: currentOrganizationName,
            role: "admin",
          },
        ];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  async function handleSelectWorkspace(workspace: WorkspaceItem) {
    if (workspace.id === currentWorkspaceId) {
      setOpen(false);
      return;
    }

    if (preview) {
      setOpen(false);
      window.location.reload();
      return;
    }

    try {
      const res = await fetch("/api/workspaces/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          organizationId: workspace.organizationId,
        }),
      });
      if (res.ok) {
        window.location.reload();
      }
    } catch {
      // fallback
      window.location.reload();
    }
  }

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (!newWsId.trim()) return;

    setCreating(true);
    setCreateError(null);

    if (preview) {
      setCreating(false);
      setModalOpen(false);
      return;
    }

    try {
      const res = await fetch("/api/setup/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: newWsId.trim().toLowerCase(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not initialize workspace.");
      }
      setModalOpen(false);
      window.location.reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Initialization failed.");
    } finally {
      setCreating(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={styles.trigger}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.iconWrap}>
          <Icon name="server" size={16} />
        </span>
        <span className={styles.textGroup}>
          <strong className={styles.workspaceName}>
            {currentOrganizationName || currentWorkspaceName}
          </strong>
          <small className={styles.organizationName}>
            {currentWorkspaceName && currentWorkspaceName !== currentOrganizationName
              ? currentWorkspaceName
              : "PostgreSQL access"}
          </small>
        </span>
        <svg
          aria-hidden="true"
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
          fill="none"
          height={14}
          viewBox="0 0 24 24"
          width={14}
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

      {open && (
        <div aria-label="Workspaces" className={styles.menu} role="listbox">
          <div className={styles.menuHeader}>
            <span>Workspaces ({choices.length})</span>
            {currentOrganizationName ? (
              <span className={styles.menuHeaderOrg}>{currentOrganizationName}</span>
            ) : null}
          </div>
          {choices.map((ws) => {
            const isSelected = ws.id.toLowerCase() === currentWorkspaceId.toLowerCase();
            return (
              <button
                aria-selected={isSelected}
                className={`${styles.option} ${isSelected ? styles.optionSelected : ""}`}
                key={`${ws.organizationId}:${ws.id}`}
                onClick={() => void handleSelectWorkspace(ws)}
                role="option"
                type="button"
              >
                <div className={styles.optionText}>
                  <div className={styles.optionName}>{ws.organizationName}</div>
                  <div className={styles.optionMeta}>
                    {ws.name !== ws.organizationName ? ws.name : "PostgreSQL access"}
                  </div>
                </div>
                <div className={styles.optionBadges}>
                  {ws.role ? <span className={styles.optionRole}>{ws.role}</span> : null}
                  {isSelected ? <Icon name="check" size={15} /> : null}
                </div>
              </button>
            );
          })}

          <div className={styles.menuDivider} />

          <Link
            className={styles.manageWorkspacesAction}
            href="/workspaces"
            onClick={() => setOpen(false)}
          >
            <Icon name="server" size={14} />
            <span>All Workspaces</span>
          </Link>

          <button
            className={styles.newWorkspaceAction}
            onClick={() => {
              setOpen(false);
              setModalOpen(true);
            }}
            type="button"
          >
            <Icon name="plus" size={14} />
            <span>New Workspace…</span>
          </button>
        </div>
      )}

      {modalOpen && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modalCard} role="dialog">
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Register New Workspace</h3>
              <button
                aria-label="Close"
                className={styles.cancelButton}
                onClick={() => setModalOpen(false)}
                type="button"
              >
                ✕
              </button>
            </div>
            <p className={styles.modalDesc}>
              Initialize a new database workspace in your Perminister organization. You will be
              granted workspace admin permissions automatically.
            </p>
            <form className={styles.modalForm} onSubmit={handleCreateWorkspace}>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="ws-name">
                  Workspace Name
                </label>
                <input
                  className={styles.formInput}
                  id="ws-name"
                  onChange={(e) => {
                    setNewWsName(e.target.value);
                    if (!newWsId || newWsId === newWsName.toLowerCase().replace(/\s+/g, "-")) {
                      setNewWsId(
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-_]/g, "-")
                          .replace(/-+/g, "-"),
                      );
                    }
                  }}
                  placeholder="e.g. Staging Cluster"
                  required
                  type="text"
                  value={newWsName}
                />
              </div>

              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="ws-id">
                  Workspace ID (Slug)
                </label>
                <input
                  className={styles.formInput}
                  id="ws-id"
                  onChange={(e) => setNewWsId(e.target.value.toLowerCase())}
                  pattern="[a-z0-9-_]{2,64}"
                  placeholder="e.g. staging-cluster"
                  required
                  type="text"
                  value={newWsId}
                />
                <span className={styles.formHint}>
                  Identifier registered with Perminister for RBAC checks.
                </span>
              </div>

              {createError && (
                <div role="alert" style={{ color: "#d9383a", fontSize: "12px" }}>
                  {createError}
                </div>
              )}

              <div className={styles.modalActions}>
                <button
                  className={styles.cancelButton}
                  onClick={() => setModalOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button className={styles.submitButton} disabled={creating} type="submit">
                  {creating ? "Registering…" : "Register Workspace"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
