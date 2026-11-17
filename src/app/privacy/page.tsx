import Link from "next/link";
import styles from "./privacy.module.css";

export const metadata = {
  title: "Privacy policy · Nanogres",
  description: "How Nanogres handles account, database-management, and backup information.",
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          nanogres
        </Link>
        <Link className={styles.backLink} href="/">
          Back to Nanogres
        </Link>
      </header>

      <article className={styles.document} aria-labelledby="privacy-title">
        <p className={styles.kicker}>Nanogres · Privacy</p>
        <h1 id="privacy-title">Privacy policy</h1>
        <p className={styles.intro}>
          Nanogres is operated by Zakai Hamilton. This policy describes information handled when
          you use the database dashboard and the Nanogres service installed on your server.
        </p>
        <p className={styles.updated}>Last updated November 17, 2026</p>

        <div className={styles.sections}>
          <section>
            <h2>Information the service handles</h2>
            <p>
              Perminister supplies the account identity, organization membership, and permissions
              used to sign in and authorize database actions. Nanogres handles the organization
              and database names, role settings, backup status, service health, and activity needed
              to show and manage your database catalog.
            </p>
            <p>
              SQL statements, database results, backup files, and one-time connection details may
              be processed when you run queries or request database transfers, imports, exports,
              backups, or restores. Import and export credentials are used for the requested job
              and are not saved after it completes. Avoid sending passwords, secrets, or unrelated
              personal information in queries or database names.
            </p>
          </section>

          <section>
            <h2>How information is used and stored</h2>
            <p>
              The dashboard runs on Vercel and calls the Nanogres API installed on the VPS you
              manage. PostgreSQL databases and server-side backups remain on that VPS; the
              dashboard uses the API to perform and display authorized operations. If you connect
              an external PostgreSQL provider for a transfer, information needed for that transfer
              is sent between your VPS and the provider you selected.
            </p>
            <p>
              Perminister provides identity and access control. Your organization controls who can
              read or manage its database catalog through the permissions granted there. Vercel,
              Perminister, your VPS host, and any PostgreSQL provider you select may process
              connection or operational data to provide their part of the service.
            </p>
          </section>

          <section>
            <h2>Cookies and browser storage</h2>
            <p>
              Nanogres uses a session cookie for sign-in, an organization-selection cookie for the
              active workspace, and a cookie for your appearance preference. The service also
              receives ordinary connection details when your browser makes a request.
            </p>
          </section>

          <section>
            <h2>Retention and control</h2>
            <p>
              The installed VPS service keeps its daily database backups for 14 days by default.
              Incomplete restore uploads are removed after 24 hours. Backups you download are
              stored on your own device, and backup retention on the VPS can be affected by its
              configuration. Other database and activity records remain until they are removed by
              an authorized organization administrator or server operator; the service does not
              set one fixed retention period for every record.
            </p>
          </section>

          <section>
            <h2>Requests and contact</h2>
            <p>
              For a privacy question or request, contact Zakai Hamilton using the contact
              information on the <a href="https://www.perminister.com/privacy">Perminister privacy
              page</a>. If your organization operates the Nanogres server, its administrator or
              server operator can also help with information kept there.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              Updates will appear on this page with a revised date as the service or its data
              handling changes.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
