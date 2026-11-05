"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/dashboard/icons";
import { ThemeControl } from "@/components/theme/theme-control";
import styles from "./welcome.module.css";

export default function WelcomePage() {
  const [activeTab, setActiveTab] = useState<"databases" | "query" | "connect">("databases");
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const sampleConnectionString = "postgresql://app_user:••••••••@127.0.0.1:5432/app_production";

  const copySampleConnection = async () => {
    try {
      await navigator.clipboard.writeText(sampleConnectionString);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link aria-label="Nanogres home" className={styles.brand} href="/">
          <Image alt="" height={34} src="/icon.png" width={34} />
          <span>nanogres</span>
        </Link>
        <nav aria-label="Main navigation" className={styles.navPills}>
          <a className={styles.navButton} href="#overview">
            Overview
          </a>
          <a className={styles.navButton} href="#capabilities">
            Capabilities
          </a>
          <a className={styles.navButton} href="#why-nanogres">
            Why Nanogres
          </a>
        </nav>
        <div className={styles.actions}>
          <ThemeControl />
          <Link className={styles.primaryButton} href="/login">
            Open Workspace <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <section aria-labelledby="hero-title" className={styles.hero} id="overview">
        <div className={styles.heroEyebrow}>PostgreSQL Workspace Console</div>
        <h1 className={styles.heroTitle} id="hero-title">
          A simpler, friendlier way to{" "}
          <span className={styles.heroTitleAccent}>manage Postgres databases.</span>
        </h1>
        <p className={styles.heroIntro}>
          Nanogres Studio gives you an intuitive control plane to manage databases, write queries in
          a clean browser studio, copy connection snippets, and manage automated backups — all in
          one place.
        </p>

        <div className={styles.heroActions}>
          <Link className={styles.ctaPrimary} href="/login">
            Open Workspace <span aria-hidden="true">→</span>
          </Link>
        </div>

        {/* Product Showcase Window */}
        <div className={styles.showcase}>
          <div className={styles.showcaseHeader}>
            <div className={styles.windowDots}>
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
            </div>
            <div className={styles.showcaseTitle}>
              <Icon name="database" size={14} />
              <span>Nanogres Studio · PostgreSQL 17</span>
            </div>
            <div className={styles.showcaseStatus}>
              <span className={styles.statusLight} />
              <span>Workspace Connected</span>
            </div>
          </div>

          <div className={styles.showcaseNav}>
            <button
              className={`${styles.showcaseTab} ${activeTab === "databases" ? styles.showcaseTabActive : ""}`}
              onClick={() => setActiveTab("databases")}
              type="button"
            >
              <Icon name="database" size={14} />
              Databases
            </button>
            <button
              className={`${styles.showcaseTab} ${activeTab === "query" ? styles.showcaseTabActive : ""}`}
              onClick={() => setActiveTab("query")}
              type="button"
            >
              <Icon name="sql" size={14} />
              SQL Studio
            </button>
            <button
              className={`${styles.showcaseTab} ${activeTab === "connect" ? styles.showcaseTabActive : ""}`}
              onClick={() => setActiveTab("connect")}
              type="button"
            >
              <Icon name="terminal" size={14} />
              Connections
            </button>
          </div>

          <div className={styles.showcaseBody}>
            {activeTab === "databases" && (
              <div className={styles.showcaseDatabases}>
                <div className={styles.showcaseSummaryBar}>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Active Databases</span>
                    <strong className={styles.summaryValue}>3</strong>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Workspace Storage</span>
                    <strong className={styles.summaryValue}>1.26 GB</strong>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Active Connections</span>
                    <strong className={styles.summaryValue}>24</strong>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Daily Backups</span>
                    <strong className={styles.summaryValuePositive}>Healthy</strong>
                  </div>
                </div>

                <div className={styles.miniTable}>
                  <div className={styles.miniTableRowHeader}>
                    <span>Database</span>
                    <span>Size</span>
                    <span>Connections</span>
                    <span>Status</span>
                  </div>
                  <div className={styles.miniTableRow}>
                    <div className={styles.dbNameCol}>
                      <Icon name="database" size={14} />
                      <strong>app_production</strong>
                    </div>
                    <span>42 MB</span>
                    <span>14 active</span>
                    <span className={styles.statusBadgeGreen}>Healthy</span>
                  </div>
                  <div className={styles.miniTableRow}>
                    <div className={styles.dbNameCol}>
                      <Icon name="database" size={14} />
                      <strong>analytics_warehouse</strong>
                    </div>
                    <span>1.20 GB</span>
                    <span>8 active</span>
                    <span className={styles.statusBadgeGreen}>Healthy</span>
                  </div>
                  <div className={styles.miniTableRow}>
                    <div className={styles.dbNameCol}>
                      <Icon name="database" size={14} />
                      <strong>auth_service</strong>
                    </div>
                    <span>18 MB</span>
                    <span>2 active</span>
                    <span className={styles.statusBadgeGreen}>Healthy</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "query" && (
              <div className={styles.showcaseQuery}>
                <div className={styles.queryEditorBar}>
                  <span className={styles.queryLabel}>Query: app_production</span>
                  <span className={styles.queryMeta}>Executed in 1.4 ms · 3 rows</span>
                </div>
                <div className={styles.querySnippet}>
                  <code>
                    <span className={styles.sqlKeyword}>SELECT</span> id, full_name, role, status{" "}
                    <span className={styles.sqlKeyword}>FROM</span> team_members{" "}
                    <span className={styles.sqlKeyword}>WHERE</span> active ={" "}
                    <span className={styles.sqlLiteral}>true</span>{" "}
                    <span className={styles.sqlKeyword}>LIMIT</span>{" "}
                    <span className={styles.sqlLiteral}>3</span>;
                  </code>
                </div>
                <div className={styles.miniTable}>
                  <div className={styles.miniTableRowHeader}>
                    <span>id</span>
                    <span>full_name</span>
                    <span>role</span>
                    <span>status</span>
                  </div>
                  <div className={styles.miniTableRow}>
                    <span className={styles.monoText}>usr_948a</span>
                    <span>Elena Vance</span>
                    <span>Administrator</span>
                    <span className={styles.statusBadgeGreen}>Active</span>
                  </div>
                  <div className={styles.miniTableRow}>
                    <span className={styles.monoText}>usr_381c</span>
                    <span>Marcus Brody</span>
                    <span>Developer</span>
                    <span className={styles.statusBadgeGreen}>Active</span>
                  </div>
                  <div className={styles.miniTableRow}>
                    <span className={styles.monoText}>usr_721f</span>
                    <span>Aria Stark</span>
                    <span>Engineer</span>
                    <span className={styles.statusBadgeGreen}>Active</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "connect" && (
              <div className={styles.showcaseConnect}>
                <div className={styles.connectIntro}>
                  <strong>Instant App Connection</strong>
                  <span>Pre-configured connection string for your active database role.</span>
                </div>
                <div className={styles.connectBox}>
                  <code>{sampleConnectionString}</code>
                  <button
                    className={styles.copyButton}
                    onClick={copySampleConnection}
                    type="button"
                  >
                    {copiedSnippet ? (
                      <>
                        <Icon name="check" size={13} /> Copied!
                      </>
                    ) : (
                      <>
                        <Icon name="copy" size={13} /> Copy String
                      </>
                    )}
                  </button>
                </div>
                <div className={styles.driverPills}>
                  <span className={styles.driverPill}>Node.js (pg)</span>
                  <span className={styles.driverPill}>Python (psycopg)</span>
                  <span className={styles.driverPill}>Go (pgx)</span>
                  <span className={styles.driverPill}>psql CLI</span>
                  <span className={styles.driverPill}>.env format</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Core Capabilities */}
      <section
        aria-labelledby="capabilities-title"
        className={styles.capabilitiesSection}
        id="capabilities"
      >
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>Product Capabilities</div>
          <h2 className={styles.sectionTitle} id="capabilities-title">
            Everything You Need to Manage PostgreSQL
          </h2>
          <p className={styles.sectionSubtitle}>
            Designed to make everyday database operations fast, approachable, and error-free.
          </p>
        </div>

        <div className={styles.cardGrid}>
          <article className={styles.capabilityCard}>
            <div className={styles.cardIconWrap}>
              <Icon name="database" size={22} />
            </div>
            <h3 className={styles.cardTitle}>Instant Database Operations</h3>
            <p className={styles.cardDesc}>
              Create, view, and organize databases with zero hassle. Inspect table schemas, row
              counts, column constraints, and storage sizes without memorizing catalog SQL.
            </p>
            <div className={styles.cardFooter}>
              <span className={styles.cardTag}>1-Click Creation</span>
              <span className={styles.cardTag}>Schema Inspector</span>
            </div>
          </article>

          <article className={styles.capabilityCard}>
            <div className={styles.cardIconWrap}>
              <Icon name="sql" size={22} />
            </div>
            <h3 className={styles.cardTitle}>Built-In Browser SQL Studio</h3>
            <p className={styles.cardDesc}>
              Run queries in a clean editor equipped with execution timing, automatic row limits,
              and read-only transaction protection so you never accidentally modify production.
            </p>
            <div className={styles.cardFooter}>
              <span className={styles.cardTag}>Query Guardrails</span>
              <span className={styles.cardTag}>CSV / JSON Export</span>
            </div>
          </article>

          <article className={styles.capabilityCard}>
            <div className={styles.cardIconWrap}>
              <Icon name="terminal" size={22} />
            </div>
            <h3 className={styles.cardTitle}>Ready-to-Use Connection Snippets</h3>
            <p className={styles.cardDesc}>
              Copy connection strings and driver boilerplate for Node.js, Python, Go, and .env
              configurations with a single click. Connect applications in seconds without guesswork.
            </p>
            <div className={styles.cardFooter}>
              <span className={styles.cardTag}>Multi-Language</span>
              <span className={styles.cardTag}>One-Click Copy</span>
            </div>
          </article>

          <article className={styles.capabilityCard}>
            <div className={styles.cardIconWrap}>
              <Icon name="backup" size={22} />
            </div>
            <h3 className={styles.cardTitle}>Automated Backups &amp; One-Click Restore</h3>
            <p className={styles.cardDesc}>
              Scheduled snapshots keep your data safe. Restore any backup into a fresh database for
              testing or recovery with complete peace of mind.
            </p>
            <div className={styles.cardFooter}>
              <span className={styles.cardTag}>Daily Snapshots</span>
              <span className={styles.cardTag}>Safe Clone &amp; Restore</span>
            </div>
          </article>
        </div>
      </section>

      {/* Why Nanogres Grid */}
      <section aria-labelledby="why-title" className={styles.whySection} id="why-nanogres">
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>Built For Developers</div>
          <h2 className={styles.sectionTitle} id="why-title">
            Engineered for Simplicity and Reliability
          </h2>
          <p className={styles.sectionSubtitle}>
            A modern, distraction-free environment tailored for teams that want to get work done.
          </p>
        </div>

        <div className={styles.whyGrid}>
          <div className={styles.whyCard}>
            <div className={styles.whyIcon}>
              <Icon name="sparkle" size={18} />
            </div>
            <h4>Frictionless Experience</h4>
            <p>
              Pre-configured and ready to use immediately. Manage your data directly without dealing
              with complicated server configurations.
            </p>
          </div>

          <div className={styles.whyCard}>
            <div className={styles.whyIcon}>
              <Icon name="shield" size={18} />
            </div>
            <h4>Safe by Default</h4>
            <p>
              Built-in query limit guardrails and read-only protection toggles safeguard against
              runaway queries and accidental data loss.
            </p>
          </div>

          <div className={styles.whyCard}>
            <div className={styles.whyIcon}>
              <Icon name="activity" size={18} />
            </div>
            <h4>Live Connection Telemetry</h4>
            <p>
              Track connection pool load in real time. Identify active sessions and cancel stalled
              queries with a single click.
            </p>
          </div>

          <div className={styles.whyCard}>
            <div className={styles.whyIcon}>
              <Icon name="access" size={18} />
            </div>
            <h4>Granular Access Control</h4>
            <p>
              Easily manage database roles and assign permissions (read-only, manager, or admin) to
              keep production data strictly controlled.
            </p>
          </div>

          <div className={styles.whyCard}>
            <div className={styles.whyIcon}>
              <Icon name="server" size={18} />
            </div>
            <h4>System Storage Visibility</h4>
            <p>
              Monitor workspace disk usage, table space growth, and backup retention room without
              leaving the web dashboard.
            </p>
          </div>

          <div className={styles.whyCard}>
            <div className={styles.whyIcon}>
              <Icon name="clock" size={18} />
            </div>
            <h4>Blazing Fast &amp; Lightweight</h4>
            <p>
              Constructed with pure SVG micro-charts and zero third-party chart bloat. Fast page
              loads and zero tracking scripts.
            </p>
          </div>
        </div>
      </section>

      {/* Bottom CTA Banner */}
      <section aria-labelledby="cta-title" className={styles.bottomCta}>
        <h2 id="cta-title">Ready to work with your databases?</h2>
        <p>
          Launch Nanogres Studio to explore your PostgreSQL databases, run queries, or configure
          scheduled snapshots.
        </p>
        <div className={styles.bottomCtaActions}>
          <Link className={styles.ctaPrimary} href="/login">
            Open Workspace <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <Image alt="" height={20} src="/icon.png" width={20} />
        </div>
        <div className={styles.footerLinks}>
          <a className={styles.footerLink} href="#overview">
            Overview
          </a>
          <a className={styles.footerLink} href="#capabilities">
            Capabilities
          </a>
          <a className={styles.footerLink} href="#why-nanogres">
            Why Nanogres
          </a>
          <Link className={styles.footerLink} href="/sql">
            SQL Studio
          </Link>
        </div>
      </footer>
    </main>
  );
}
