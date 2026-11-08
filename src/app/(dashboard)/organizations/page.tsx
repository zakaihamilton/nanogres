import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getCurrentPerministerSession,
  getNanogresOrganizationContext,
} from "@/lib/perminister-auth";
import styles from "./organizations.module.css";

export const metadata: Metadata = { title: "Organization access · Nanogres" };
export const dynamic = "force-dynamic";

export default async function OrganizationsPage() {
  const session = await getCurrentPerministerSession();
  if (!session) redirect("/login");

  const context = await getNanogresOrganizationContext(session);
  if (context instanceof Response) redirect("/overview");

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>ACCESS</p>
        <h1>Organization database access</h1>
        <p>
          Nanogres manages the PostgreSQL databases assigned to each Perminister organization.
          Organization membership controls which database catalog you can open.
        </p>
      </header>
      <div className={styles.list}>
        {context.availableOrganizations.map((organization) => (
          <article className={styles.card} key={organization.organizationId}>
            <div>
              <h2>{organization.organizationName}</h2>
              <p>PostgreSQL database catalog</p>
            </div>
            <div className={styles.badges}>
              <span className={styles.role}>{organization.role}</span>
              {organization.organizationId === context.organizationId ? (
                <span className={styles.current}>Selected</span>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <p className={styles.note}>
        Nanogres product permissions are managed in Perminister. Database access uses the
        organization scope, so members of one organization see the same organization database list.
      </p>
    </section>
  );
}
