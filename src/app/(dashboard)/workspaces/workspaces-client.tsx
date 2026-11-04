"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/dashboard/icons";
import { PageHeader, Button } from "@/components/dashboard/live-shared";
import type { WorkspaceItem } from "@/components/dashboard/workspace-switcher";
import styles from "./workspaces.module.css";

type Props = {
  currentWorkspaceId: string;
  currentOrganizationId: string;
  currentOrganizationName: string;
  role: string;
  workspaces: WorkspaceItem[];
};

export function WorkspacesClient({
  currentWorkspaceId,
  currentOrganizationId,
  currentOrganizationName,
  role,
  workspaces,
}: Props) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkspaceItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSlug, setRenameSlug] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsId, setNewWsId] = useState("");
  const [registering, setRegistering] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [items, setItems] = useState<WorkspaceItem[]>(workspaces);

  async function handleRenameWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget) return;

    setRenaming(true);
    setErrorMessage(null);

    const isSlugChange = renameSlug.trim().toLowerCase() !== renameTarget.id.toLowerCase();

    try {
      const res = await fetch("/api/workspaces/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: renameTarget.id,
          newWorkspaceId: renameSlug.trim().toLowerCase(),
          name: renameValue.trim(),
          organizationId: renameTarget.organizationId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to rename workspace.");
      }
      setRenameTarget(null);
      if (isSlugChange) {
        window.location.reload();
      } else {
        setItems((prev) =>
          prev.map((item) =>
            item.id === renameTarget.id ? { ...item, name: renameValue.trim() || item.name } : item,
          ),
        );
        router.refresh();
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to rename workspace.");
    } finally {
      setRenaming(false);
    }
  }

  async function handleSwitchWorkspace(workspace: WorkspaceItem) {
    if (workspace.id === currentWorkspaceId) return;

    setSwitchingId(workspace.id);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/workspaces/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          organizationId: workspace.organizationId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to switch workspace.");
      }
      router.push("/overview");
      router.refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to switch workspace.");
      setSwitchingId(null);
    }
  }

  async function handleRegisterWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (!newWsId.trim()) return;

    setRegistering(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/setup/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: newWsId.trim().toLowerCase(),
          organizationId: currentOrganizationId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Could not register workspace in Perminister.");
      }
      setModalOpen(false);
      router.push("/overview");
      router.refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Registration failed.");
      setRegistering(false);
    }
  }

  return (
    <div className={styles.pageContainer}>
      <PageHeader
        eyebrow="MULTI-WORKSPACE CONTROL"
        title="Postgres Workspaces"
        description="Switch between isolated PostgreSQL workspace clusters or initialize a new workspace for your Perminister organization."
        action={
          <Button onClick={() => setModalOpen(true)} variant="primary">
            <Icon name="plus" size={14} />
            <span>Register Workspace</span>
          </Button>
        }
      />

      {errorMessage && (
        <div className={styles.errorBanner} role="alert">
          {errorMessage}
        </div>
      )}

      <div className={styles.orgSummary}>
        <div className={styles.orgDetails}>
          <div className={styles.orgIcon}>
            <Icon name="shield" size={20} />
          </div>
          <div className={styles.orgText}>
            <span className={styles.orgTitle}>{currentOrganizationName}</span>
            <span className={styles.orgMeta}>
              {workspaces.length} registered {workspaces.length === 1 ? "workspace" : "workspaces"}{" "}
              in this organization
            </span>
          </div>
        </div>
        <span className={styles.orgBadge}>{role} access</span>
      </div>

      <div className={styles.grid}>
        {items.map((ws) => {
          const isActive = ws.id.toLowerCase() === currentWorkspaceId.toLowerCase();
          const isSwitching = switchingId === ws.id;

          return (
            <div
              className={`${styles.card} ${isActive ? styles.cardActive : ""}`}
              key={`${ws.organizationId}:${ws.id}`}
            >
              <div>
                <div className={styles.cardTop}>
                  <div className={styles.cardHeading}>
                    <h2 className={styles.cardName}>{ws.name}</h2>
                    <span className={styles.cardSlug}>{ws.id}</span>
                  </div>
                  <div className={styles.badges}>
                    {isActive ? (
                      <span className={styles.activeBadge}>
                        <span className={styles.activeDot} />
                        Active
                      </span>
                    ) : null}
                    {ws.role ? <span className={styles.roleBadge}>{ws.role}</span> : null}
                  </div>
                </div>

                <div className={styles.cardMeta}>
                  <span>Organization: {ws.organizationName}</span>
                  <span>Cluster scope: PostgreSQL workspace</span>
                </div>
              </div>

              <div className={styles.cardBottom}>
                <button
                  className={styles.renameButton}
                  onClick={() => {
                    setRenameTarget(ws);
                    setRenameValue(ws.name);
                    setRenameSlug(ws.id);
                  }}
                  type="button"
                >
                  <Icon name="sparkle" size={13} />
                  <span>Rename</span>
                </button>

                <div className={styles.cardBottomActions}>
                  {isActive ? (
                    <span className={`${styles.actionButton} ${styles.currentButton}`}>
                      <Icon name="check" size={15} />
                      Current
                    </span>
                  ) : (
                    <button
                      className={`${styles.actionButton} ${styles.switchButton}`}
                      disabled={isSwitching}
                      onClick={() => void handleSwitchWorkspace(ws)}
                      type="button"
                    >
                      {isSwitching ? (
                        "Switching…"
                      ) : (
                        <>
                          <span>Switch</span>
                          <span aria-hidden="true">→</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {renameTarget && (
        <div className={styles.modalBackdrop}>
          <div aria-modal="true" className={styles.modalCard} role="dialog">
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>Rename Workspace</h2>
              <button
                aria-label="Close"
                className={styles.closeButton}
                onClick={() => setRenameTarget(null)}
                type="button"
              >
                ✕
              </button>
            </div>
            <p className={styles.modalDesc}>
              Update the friendly display name for workspace <code>{renameTarget.id}</code> in{" "}
              <strong>{renameTarget.organizationName}</strong>.
            </p>
            <form className={styles.modalForm} onSubmit={handleRenameWorkspace}>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="ws-rename-val">
                  Display Name
                </label>
                <input
                  className={styles.formInput}
                  id="ws-rename-val"
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="e.g. Production Cluster"
                  required
                  type="text"
                  value={renameValue}
                />
              </div>

              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="ws-rename-slug">
                  Workspace Slug (ID)
                </label>
                <input
                  className={styles.formInput}
                  id="ws-rename-slug"
                  onChange={(e) => setRenameSlug(e.target.value.toLowerCase())}
                  pattern="[a-z0-9-_]{2,64}"
                  placeholder="e.g. production-cluster"
                  required
                  type="text"
                  value={renameSlug}
                />
                <span className={styles.formHint}>
                  Identifier registered with Perminister. Changing the slug registers the new scope
                  and updates active session cookies.
                </span>
              </div>

              <div className={styles.modalActions}>
                <button
                  className={styles.cancelButton}
                  onClick={() => setRenameTarget(null)}
                  type="button"
                >
                  Cancel
                </button>
                <button className={styles.submitButton} disabled={renaming} type="submit">
                  {renaming ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {modalOpen && (
        <div className={styles.modalBackdrop}>
          <div aria-modal="true" className={styles.modalCard} role="dialog">
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>Register New Workspace</h2>
              <button
                aria-label="Close"
                className={styles.closeButton}
                onClick={() => setModalOpen(false)}
                type="button"
              >
                ✕
              </button>
            </div>
            <p className={styles.modalDesc}>
              Initialize a new database workspace in <strong>{currentOrganizationName}</strong>.
              Perminister will grant you workspace admin privileges.
            </p>
            <form className={styles.modalForm} onSubmit={handleRegisterWorkspace}>
              <div className={styles.formField}>
                <label className={styles.formLabel} htmlFor="ws-reg-name">
                  Workspace Name
                </label>
                <input
                  className={styles.formInput}
                  id="ws-reg-name"
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
                <label className={styles.formLabel} htmlFor="ws-reg-id">
                  Workspace ID (Slug)
                </label>
                <input
                  className={styles.formInput}
                  id="ws-reg-id"
                  onChange={(e) => setNewWsId(e.target.value.toLowerCase())}
                  pattern="[a-z0-9-_]{2,64}"
                  placeholder="e.g. staging-cluster"
                  required
                  type="text"
                  value={newWsId}
                />
                <span className={styles.formHint}>
                  Identifier registered with Perminister for RBAC checks and authorization.
                </span>
              </div>

              <div className={styles.modalActions}>
                <button
                  className={styles.cancelButton}
                  onClick={() => setModalOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button className={styles.submitButton} disabled={registering} type="submit">
                  {registering ? "Registering…" : "Register Workspace"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
