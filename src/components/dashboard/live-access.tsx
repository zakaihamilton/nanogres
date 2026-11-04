"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/select";
import {
  type Role,
  apiRequest,
  useApiData,
  formatDate,
  PageHeader,
  Button,
  Panel,
  Notice,
  Loading,
  Empty,
  ErrorNotice,
  useDatabases,
} from "./live-shared";
import styles from "./live-screens.module.css";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard-focusable regions let users scroll wide data tables on small screens. */
export function LiveAccessScreen({ page = "list" }: { page?: "list" | "new" }) {
  const {
    databases,
    error: databaseError,
    loading: databaseLoading,
    refresh: refreshDatabases,
  } = useDatabases();
  const userDatabases = databases.filter((item) => !item.systemDatabase);
  const rolesQuery = useApiData<{ roles: Role[] }>("/api/nanogres/roles");
  const roles = rolesQuery.data?.roles ?? [];
  const [name, setName] = useState("");
  const [database, setDatabase] = useState("");
  const selectedDatabase = database || userDatabases[0]?.name || "";
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<"readwrite" | "readonly">("readwrite");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      await apiRequest("/api/nanogres/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, database: selectedDatabase, password, access }),
      });
      setName("");
      setPassword("");
      setMessage(
        `Role “${name}” created for ${selectedDatabase}. Store the password safely; Nanogres will not show it again.`,
      );
      await rolesQuery.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not create role.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.screen}>
      <PageHeader
        description="Create least-privilege Postgres login roles for individual databases."
        eyebrow="SECURITY"
        title={page === "new" ? "Create a database role" : "Access & roles"}
      />
      <ErrorNotice
        error={databaseError ?? rolesQuery.error}
        onRetry={() => {
          if (databaseError) void refreshDatabases();
          if (rolesQuery.error) void rolesQuery.refresh();
        }}
      />
      <ErrorNotice error={actionError} />
      {message ? <Notice tone="info">{message}</Notice> : null}
      <Notice tone="info">
        People and their Nanogres permissions are managed in Perminister. These are database login
        roles for your applications.
      </Notice>
      {page === "new" ? (
        <>
          <Link href="/access">← Back to login roles</Link>
          <Panel
            title="Create a database role"
            detail="Passwords are sent over HTTPS, stored by Postgres as SCRAM hashes, and never displayed again."
          >
            {databaseLoading ? (
              <Loading />
            ) : databaseError && !userDatabases.length ? (
              <Empty>Nanogres could not load databases. Use Try again above to retry.</Empty>
            ) : userDatabases.length ? (
              <form className={styles.formGrid} onSubmit={createRole}>
                <div className={styles.field}>
                  <label htmlFor="role-name">Role name</label>
                  <input
                    id="role-name"
                    maxLength={63}
                    minLength={2}
                    onChange={(event) => setName(event.target.value)}
                    pattern="[a-z][a-z0-9_]{1,62}"
                    placeholder="my_app_user"
                    required
                    value={name}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="role-database">Database</label>
                  <Select
                    id="role-database"
                    onChange={setDatabase}
                    required
                    value={selectedDatabase}
                  >
                    {userDatabases.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="role-access">Access level</label>
                  <Select
                    id="role-access"
                    onChange={(value) => setAccess(value as "readwrite" | "readonly")}
                    value={access}
                  >
                    <option value="readwrite">Read and write</option>
                    <option value="readonly">Read only</option>
                  </Select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="role-password">Initial password</label>
                  <input
                    autoComplete="new-password"
                    id="role-password"
                    minLength={16}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                  <small>
                    Use at least 16 characters. Generate and store it in your password manager.
                  </small>
                </div>
                <div className={styles.formActions}>
                  <Button disabled={saving} type="submit">
                    {saving ? "Creating…" : "Create role"}
                  </Button>
                </div>
              </form>
            ) : (
              <Empty>Create a database before adding a login role.</Empty>
            )}
          </Panel>
        </>
      ) : (
        <>
          <Link className={styles.primaryButton} href="/access/new">
            Create role
          </Link>
          <Panel
            title="Login roles"
            detail={`${roles.length} Postgres login role${roles.length === 1 ? "" : "s"}`}
          >
            {rolesQuery.loading && !rolesQuery.data ? (
              <Loading />
            ) : rolesQuery.error && !rolesQuery.data ? (
              <Empty>Nanogres could not load database roles. Use Try again above to retry.</Empty>
            ) : roles.length ? (
              <div aria-label="Login roles" className={styles.tableWrap} role="region" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Role</th>
                      <th scope="col">Privileges</th>
                      <th scope="col">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => (
                      <tr key={role.name}>
                        <td>
                          <span className={styles.databaseName}>{role.name}</span>
                          {role.systemRole ? (
                            <small className={styles.systemTag}>system</small>
                          ) : null}
                        </td>
                        <td>
                          {role.superuser
                            ? "Superuser"
                            : [
                                role.canCreateDatabase ? "Create database" : "",
                                role.canCreateRole ? "Create roles" : "",
                              ]
                                .filter(Boolean)
                                .join(" · ") || "Database grants"}
                        </td>
                        <td>{role.validUntil ? formatDate(role.validUntil) : "Never"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No login roles found.</Empty>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
