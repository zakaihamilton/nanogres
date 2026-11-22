"use client";

import { type FormEvent, useState } from "react";
import { Select } from "@/components/ui/select";
import { generateSecurePassword } from "@/lib/generate-password";
import { TENANT_NAME_MAX_LENGTH, TENANT_NAME_PATTERN } from "@/lib/tenant-names";
import { Icon } from "../icons";
import formStyles from "./forms-preview.module.css";
import { DataTable, Panel, ScreenHeading } from "./primitives";
import styles from "./primitives.module.css";

function RoleCreatePreviewForm({ onSubmit }: { onSubmit?: (name: string) => void }) {
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("role-name") ?? "");
    onSubmit?.(name);
    form.reset();
    setPassword("");
    setPasswordVisible(false);
  }

  return (
    <form className={formStyles.previewFormGrid} onSubmit={submit}>
      <div className={formStyles.previewField}>
        <label htmlFor="preview-role-name">Role name</label>
        <input
          autoComplete="off"
          id="preview-role-name"
          maxLength={TENANT_NAME_MAX_LENGTH}
          minLength={2}
          name="role-name"
          pattern={TENANT_NAME_PATTERN}
          placeholder="my_app_user"
          required
        />
      </div>
      <div className={formStyles.previewField}>
        <label htmlFor="preview-role-database">Database</label>
        <Select defaultValue="app_main" id="preview-role-database" name="database">
          <option value="app_main">app_main</option>
          <option value="event_store">event_store</option>
          <option value="sandbox">sandbox</option>
        </Select>
      </div>
      <div className={formStyles.previewField}>
        <label htmlFor="preview-role-access">Access level</label>
        <Select defaultValue="readwrite" id="preview-role-access" name="access">
          <option value="readwrite">Read and write</option>
          <option value="readonly">Read only</option>
        </Select>
      </div>
      <div className={formStyles.previewField}>
        <label htmlFor="preview-role-password">Initial password</label>
        <div className={formStyles.passwordInputRow}>
          <input
            autoComplete="new-password"
            id="preview-role-password"
            minLength={16}
            name="role-password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type={passwordVisible ? "text" : "password"}
            value={password}
          />
          <button
            aria-controls="preview-role-password"
            aria-label={passwordVisible ? "Hide password" : "Show password"}
            aria-pressed={passwordVisible}
            className={styles.secondaryButton}
            onClick={() => setPasswordVisible((visible) => !visible)}
            type="button"
          >
            {passwordVisible ? "Hide" : "Show"}
          </button>
          <button
            className={styles.secondaryButton}
            onClick={() => setPassword(generateSecurePassword())}
            type="button"
          >
            Generate
          </button>
        </div>
        <small>
          Generate a secure 24-character password, show it, then save it in your password manager.
        </small>
      </div>
      <div className={formStyles.previewFormActions}>
        <button disabled={!onSubmit} type="submit">
          Create role
        </button>
      </div>
    </form>
  );
}

function RoleTable({ variant }: { variant: "database" | "access" }) {
  const roles = [
    { name: "app_service", access: "Read and write", database: "app_main" },
    { name: "report_reader", access: "Read only", database: "event_store" },
  ];
  const databaseDetails = variant === "database";
  return (
    <DataTable
      label={databaseDetails ? "Database roles" : "Access roles"}
      columns={[
        { id: "role", label: "Role" },
        { id: "access", label: databaseDetails ? "Access" : "Privileges" },
        { id: "scope", label: databaseDetails ? "Database" : "Expires" },
      ]}
    >
      {roles.map((role) => (
        <tr key={role.name}>
          <td>
            <strong>{role.name}</strong>
          </td>
          <td>{role.access}</td>
          <td className={styles.mutedCell}>{databaseDetails ? role.database : "Never"}</td>
        </tr>
      ))}
    </DataTable>
  );
}

export function AccessScreen({
  onPreviewCreateRole,
  onPreviewNavigate,
  previewPage = "list",
  previewNotice,
  readOnly = false,
}: {
  onPreviewCreateRole?: (name: string) => void;
  onPreviewNavigate?: (screen: string) => void;
  previewPage?: "list" | "new";
  previewNotice?: string | null;
  readOnly?: boolean;
}) {
  return (
    <div className={styles.screen}>
      <ScreenHeading
        action={previewPage === "list" && !readOnly ? "Create role" : undefined}
        description="Create least-privilege Postgres login roles for individual databases."
        eyebrow="SECURITY"
        title="Access & roles"
        onAction={() => onPreviewNavigate?.("access-new")}
      />
      {previewNotice ? (
        <div className={styles.previewNotice} role="status">
          {previewNotice}
        </div>
      ) : null}
      <div className={formStyles.accessNotice}>
        <span>
          <Icon name="shield" size={18} />
        </span>
        <p>
          People and Nanogres permissions are managed in Perminister. These are database login roles
          for your applications.
        </p>
      </div>
      {previewPage === "new" ? (
        <Panel
          title="Create a database role"
          detail="Passwords are never shown again after creation."
        >
          <RoleCreatePreviewForm onSubmit={readOnly ? undefined : onPreviewCreateRole} />
        </Panel>
      ) : (
        <Panel title="Login roles" detail="2 Postgres login roles">
          <RoleTable variant="access" />
        </Panel>
      )}
    </div>
  );
}
