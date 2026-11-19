// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Keyboard-focusable dashboard regions allow keyboard scrolling of wide tables.
"use client";

import { useState, type FormEvent } from "react";
import { Select } from "@/components/ui/select";
import { nanogresToast } from "@/components/ui/toast";
import {
  apiRequest,
  Button,
  Empty,
  ErrorNotice,
  Loading,
  Panel,
  useApiData,
  type Database,
  type Role,
} from "./live-shared";
import styles from "./live-screens.module.css";

type WorkloadIdentityGrant = {
  id: string;
  name: string;
  issuer: string;
  audience: string;
  subject: string;
  database: string;
  role: string;
  createdAt: string;
};

export function LiveWorkloadIdentities({
  databases,
  roles,
}: {
  databases: Database[];
  roles: Role[];
}) {
  const identitiesQuery = useApiData<{ identities: WorkloadIdentityGrant[] }>(
    "/api/nanogres/workload-identities",
  );
  const userDatabases = databases.filter((database) => !database.systemDatabase);
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [audience, setAudience] = useState("");
  const [subject, setSubject] = useState("");
  const [database, setDatabase] = useState("");
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedDatabase = database || userDatabases[0]?.name || "";
  const eligibleRoles = roles.filter(
    (candidate) => candidate.database === selectedDatabase && !candidate.systemRole,
  );
  const selectedRole = role || eligibleRoles[0]?.name || "";
  const identities = identitiesQuery.data?.identities ?? [];

  async function createIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      await apiRequest("/api/nanogres/workload-identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          issuer,
          audience,
          subject,
          database: selectedDatabase,
          role: selectedRole,
        }),
      });
      setName("");
      setIssuer("");
      setAudience("");
      setSubject("");
      setRole("");
      nanogresToast.success(`Workload identity “${name}” added`);
      await identitiesQuery.refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not add workload identity.";
      setActionError(message);
      nanogresToast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function revokeIdentity(identity: WorkloadIdentityGrant) {
    setActionError(null);
    try {
      await apiRequest(`/api/nanogres/workload-identities/${encodeURIComponent(identity.id)}`, {
        method: "DELETE",
      });
      nanogresToast.success(`Workload identity “${identity.name}” revoked`);
      await identitiesQuery.refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not revoke workload identity.";
      setActionError(message);
      nanogresToast.error(message);
    }
  }

  return (
    <>
      <ErrorNotice
        error={actionError ?? identitiesQuery.error}
        onRetry={() => void identitiesQuery.refresh()}
      />
      <Panel
        title="Workload identities"
        detail="Connect server products with short-lived SSH keys and certificates instead of database passwords."
      >
        {!userDatabases.length ? (
          <Empty>Create an organization database before adding a workload identity.</Empty>
        ) : identitiesQuery.loading && !identitiesQuery.data ? (
          <Loading />
        ) : identitiesQuery.error && !identitiesQuery.data ? (
          <Empty>Nanogres could not load workload identities. Use Try again above to retry.</Empty>
        ) : (
          <>
            <form className={styles.formGrid} method="post" onSubmit={createIdentity}>
              <div className={styles.field}>
                <label htmlFor="workload-identity-name">Product or workload name</label>
                <input
                  autoComplete="off"
                  id="workload-identity-name"
                  onChange={(event) => setName(event.target.value)}
                  required
                  value={name}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="workload-identity-issuer">OIDC issuer</label>
                <input
                  autoComplete="url"
                  id="workload-identity-issuer"
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder="https://oidc.vercel.com/team"
                  required
                  type="url"
                  value={issuer}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="workload-identity-audience">Audience</label>
                <input
                  autoComplete="off"
                  id="workload-identity-audience"
                  onChange={(event) => setAudience(event.target.value)}
                  placeholder="https://vercel.com/team"
                  required
                  value={audience}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="workload-identity-subject">Subject</label>
                <input
                  autoComplete="off"
                  id="workload-identity-subject"
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="owner:team:project:visitoring:environment:production"
                  required
                  value={subject}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="workload-identity-database">Database</label>
                <Select
                  id="workload-identity-database"
                  onChange={(value) => {
                    setDatabase(value);
                    setRole("");
                  }}
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
                <label htmlFor="workload-identity-role">Login role</label>
                <Select
                  id="workload-identity-role"
                  onChange={setRole}
                  value={selectedRole}
                >
                  {eligibleRoles.map((item) => (
                    <option key={item.loginName} value={item.name}>
                      {item.name}{item.migrationRole ? " · schema migration" : ""}
                    </option>
                  ))}
                </Select>
              </div>
              <div className={styles.formActions}>
                <Button disabled={saving || !selectedDatabase || !selectedRole} type="submit">
                  {saving ? "Adding…" : "Add workload identity"}
                </Button>
              </div>
            </form>
            {identities.length ? (
              <div
                aria-label="Workload identity grants"
                className={styles.tableWrap}
                role="region"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Workload</th>
                      <th scope="col">OIDC identity</th>
                      <th scope="col">Database role</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {identities.map((identity) => (
                      <tr key={identity.id}>
                        <td>{identity.name}</td>
                        <td>
                          <code>{identity.issuer}</code>
                          <br />
                          <code>{identity.subject}</code>
                        </td>
                        <td>{identity.database} · {identity.role}</td>
                        <td>
                          <button
                            className={styles.rowAction}
                            onClick={() => void revokeIdentity(identity)}
                            type="button"
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No workload identity grants yet.</Empty>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
