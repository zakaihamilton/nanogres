// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Keyboard-focusable dashboard regions allow keyboard scrolling of wide tables.
"use client";

import { useState, useMemo, type FormEvent } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/select";
import { ConnectionModal } from "@/components/ui/connection-modal";
import { nanogresToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { generateSecurePassword } from "@/lib/generate-password";
import { Icon } from "./icons";
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
import { TENANT_NAME_MAX_LENGTH, TENANT_NAME_PATTERN } from "@/lib/tenant-names";

export function LiveAccessScreen({ page = "list" }: { page?: "list" | "new" }) {
  const {
    databases,
    error: databaseError,
    loading: databaseLoading,
    refresh: refreshDatabases,
  } = useDatabases();
  const userDatabases = databases.filter((item) => !item.systemDatabase);
  const rolesQuery = useApiData<{ roles: Role[] }>("/api/nanogres/roles");
  const rawRoles = rolesQuery.data?.roles;

  const [name, setName] = useState("");
  const [database, setDatabase] = useState("");
  const selectedDatabase = database || userDatabases[0]?.name || "";
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [access, setAccess] = useState<"readwrite" | "readonly" | "migration">("readwrite");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Search & connect modal
  const [searchQuery, setSearchQuery] = useState("");
  const [connectRole, setConnectRole] = useState<Role | null>(null);

  const filteredRoles = useMemo(() => {
    if (!rawRoles) return [];
    if (!searchQuery.trim()) return rawRoles;
    const q = searchQuery.toLowerCase().trim();
    return rawRoles.filter((r) => r.name.toLowerCase().includes(q));
  }, [rawRoles, searchQuery]);

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
      setPasswordVisible(false);
      const successMsg = `Role “${name}” created for ${selectedDatabase}. Store the password safely; Nanogres will not show it again.`;
      setMessage(successMsg);
      nanogresToast.success(`Role “${name}” created successfully`);
      await rolesQuery.refresh();
    } catch (cause) {
      const err = cause instanceof Error ? cause.message : "Could not create role.";
      setActionError(err);
      nanogresToast.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.screen}>
      <PageHeader
        action={
          page === "list" ? (
            <Link className={styles.primaryButton} href="/access/new">
              Create role
            </Link>
          ) : undefined
        }
        description="Create database-scoped read-only, read-write, or schema-migration login roles."
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
          <Panel
            title="Create a database role"
            detail="Passwords are sent over HTTPS, stored by Postgres as SCRAM hashes, and never displayed again."
          >
            {databaseLoading ? (
              <Loading />
            ) : databaseError && !userDatabases.length ? (
              <Empty>Nanogres could not load databases. Use Try again above to retry.</Empty>
            ) : userDatabases.length ? (
              <form className={styles.formGrid} method="post" onSubmit={createRole}>
                <div className={styles.field}>
                  <label htmlFor="role-name">Role name</label>
                  <input
                    autoComplete="off"
                    id="role-name"
                    maxLength={TENANT_NAME_MAX_LENGTH}
                    minLength={2}
                    onChange={(event) => setName(event.target.value)}
                    pattern={TENANT_NAME_PATTERN}
                    placeholder="app_service"
                    required
                    value={name}
                  />
                  <small>
                    Lowercase letters, numbers, and underscores. Max {TENANT_NAME_MAX_LENGTH}{" "}
                    characters.
                  </small>
                </div>
                <div className={styles.field}>
                  <label htmlFor="role-database">Database</label>
                  <Select id="role-database" onChange={setDatabase} value={selectedDatabase}>
                    {userDatabases.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                  <small>The role can connect only to this database.</small>
                </div>
                <div className={styles.field}>
                  <label htmlFor="role-access">Access level</label>
                  <Select
                    id="role-access"
                    onChange={(val) => setAccess(val as "readwrite" | "readonly" | "migration")}
                    value={access}
                  >
                    <option value="readwrite">Read and write</option>
                    <option value="readonly">Read-only</option>
                    <option value="migration">Schema migration</option>
                  </Select>
                  <small>
                    {access === "readwrite"
                      ? "Can query, insert, update, and delete in this database's public schema."
                      : access === "readonly"
                        ? "Can query existing tables in this database's public schema."
                        : "Uses the session-pooling endpoint and can assume the database owner role to run migrations."}
                  </small>
                </div>
                <div className={styles.field}>
                  <label htmlFor="role-password">Password</label>
                  <div className={styles.passwordInputRow}>
                    <input
                      autoComplete="new-password"
                      id="role-password"
                      minLength={16}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="At least 16 characters"
                      required
                      type={passwordVisible ? "text" : "password"}
                      value={password}
                    />
                    <button
                      aria-controls="role-password"
                      aria-label={passwordVisible ? "Hide password" : "Show password"}
                      aria-pressed={passwordVisible}
                      className={`${styles.button} ${styles.secondary}`}
                      onClick={() => setPasswordVisible((visible) => !visible)}
                      type="button"
                    >
                      {passwordVisible ? "Hide" : "Show"}
                    </button>
                    <Button
                      onClick={() => setPassword(generateSecurePassword())}
                      type="button"
                      variant="secondary"
                    >
                      Generate
                    </Button>
                  </div>
                  <small>
                    Generate a secure 24-character password, show it, then save it in your password
                    manager.
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
          <div className={styles.tableToolbar}>
            <div className={styles.searchInputWrap}>
              <Icon name="search" size={14} />
              <input
                aria-label="Search roles"
                className={styles.searchInput}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search login roles..."
                value={searchQuery}
              />
            </div>
          </div>

          <Panel
            title="Login roles"
            detail={`${filteredRoles.length} Postgres login role${filteredRoles.length === 1 ? "" : "s"}`}
          >
            {rolesQuery.loading && !rolesQuery.data ? (
              <Loading />
            ) : rolesQuery.error && !rolesQuery.data ? (
              <Empty>Nanogres could not load database roles. Use Try again above to retry.</Empty>
            ) : filteredRoles.length ? (
              <div aria-label="Login roles" className={styles.tableWrap} role="region" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Role</th>
                      <th scope="col">Privileges</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRoles.map((role) => (
                      <tr key={role.name}>
                        <td>
                          <span className={styles.databaseName}>{role.name}</span>
                          {role.systemRole ? (
                            <small className={styles.systemTag}>system</small>
                          ) : role.migrationRole ? (
                            <small className={styles.systemTag}>migration</small>
                          ) : null}
                        </td>
                        <td>
                          {role.superuser
                            ? "Superuser"
                            : role.migrationRole
                              ? "Schema migrations"
                              : [
                                  role.canCreateDatabase ? "Create database" : "",
                                  role.canCreateRole ? "Create roles" : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "Database grants"}
                        </td>
                        <td>{role.validUntil ? formatDate(role.validUntil) : "Never"}</td>
                        <td>
                          <Tooltip
                            label={
                              !role.connectionDatabase ? "Role has no database access" : undefined
                            }
                          >
                            <button
                              className={styles.rowAction}
                              disabled={!role.connectionDatabase}
                              onClick={() => setConnectRole(role)}
                              type="button"
                            >
                              Connect snippet
                            </button>
                          </Tooltip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {searchQuery.trim()
                  ? `No login roles match your search “${searchQuery}”.`
                  : "No login roles found."}
              </Empty>
            )}
          </Panel>
        </>
      )}

      <ConnectionModal
        database={connectRole?.connectionDatabase ?? ""}
        isOpen={Boolean(connectRole?.connectionDatabase)}
        onClose={() => setConnectRole(null)}
        user={connectRole?.loginName ?? "your_role"}
        migrationRole={connectRole?.migrationRole ?? false}
        assumeRole={connectRole?.assumeRole ?? undefined}
      />
    </div>
  );
}
