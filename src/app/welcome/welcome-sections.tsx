import { Icon } from "@/components/dashboard/icons";
import styles from "../welcome.module.css";

const CAPABILITIES = [
  {
    icon: "database" as const,
    title: "Instant Database Operations",
    description:
      "Create, view, and organize databases with zero hassle. Inspect table schemas, row counts, column constraints, and storage sizes without memorizing catalog SQL.",
    tags: ["1-Click Creation", "Schema Inspector"],
  },
  {
    icon: "sql" as const,
    title: "Built-In Browser SQL Studio",
    description:
      "Run queries in a clean editor equipped with execution timing, automatic row limits, and read-only transaction protection so you never accidentally modify production.",
    tags: ["Query Guardrails", "CSV / JSON Export"],
  },
  {
    icon: "terminal" as const,
    title: "Ready-to-Use Connection Snippets",
    description:
      "Copy connection strings and driver boilerplate for Node.js, Python, Go, and .env configurations with a single click. Connect applications in seconds without guesswork.",
    tags: ["Multi-Language", "One-Click Copy"],
  },
  {
    icon: "backup" as const,
    title: "Automated Backups & One-Click Restore",
    description:
      "Scheduled snapshots keep your data safe. Restore any backup into a fresh database for testing or recovery with complete peace of mind.",
    tags: ["Daily Snapshots", "Safe Clone & Restore"],
  },
] as const;

const WHY_NANOGRES_ITEMS = [
  {
    icon: "sparkle" as const,
    title: "Frictionless Experience",
    description:
      "Pre-configured and ready to use immediately. Manage your data directly without dealing with complicated server configurations.",
  },
  {
    icon: "shield" as const,
    title: "Safe by Default",
    description:
      "Built-in query limit guardrails and read-only protection toggles safeguard against runaway queries and accidental data loss.",
  },
  {
    icon: "activity" as const,
    title: "Live Connection Telemetry",
    description:
      "Track connection pool load in real time. Identify active sessions and cancel stalled queries with a single click.",
  },
  {
    icon: "access" as const,
    title: "Granular Access Control",
    description:
      "Easily manage database roles and assign permissions (read-only, manager, or admin) to keep production data strictly controlled.",
  },
  {
    icon: "server" as const,
    title: "System Storage Visibility",
    description:
      "Monitor VPS disk usage, table space growth, and backup retention room without leaving the web dashboard.",
  },
  {
    icon: "clock" as const,
    title: "Blazing Fast & Lightweight",
    description:
      "Constructed with pure SVG micro-charts and zero third-party chart bloat. Fast page loads and zero tracking scripts.",
  },
] as const;

export function CapabilitiesSection() {
  return (
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
        {CAPABILITIES.map((cap) => (
          <article className={styles.capabilityCard} key={cap.title}>
            <div className={styles.cardIconWrap}>
              <Icon name={cap.icon} size={22} />
            </div>
            <h3 className={styles.cardTitle}>{cap.title}</h3>
            <p className={styles.cardDesc}>{cap.description}</p>
            <div className={styles.cardFooter}>
              {cap.tags.map((tag) => (
                <span className={styles.cardTag} key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function WhyNanogresSection() {
  return (
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
        {WHY_NANOGRES_ITEMS.map((item) => (
          <div className={styles.whyCard} key={item.title}>
            <div className={styles.whyIcon}>
              <Icon name={item.icon} size={18} />
            </div>
            <h4>{item.title}</h4>
            <p>{item.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
