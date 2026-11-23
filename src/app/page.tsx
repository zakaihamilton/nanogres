import Image from "next/image";
import Link from "next/link";
import { ThemeControl } from "@/components/theme/theme-control";
import { ProductShowcase } from "./welcome/product-showcase";
import { CapabilitiesSection, WhyNanogresSection } from "./welcome/welcome-sections";
import styles from "./welcome.module.css";

export default function WelcomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link aria-label="Nanogres home" className={styles.brand} href="/">
          <Image alt="" height={34} src="/brand-icon.png" width={34} />
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
            Open Dashboard <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>

      <section aria-labelledby="hero-title" className={styles.hero} id="overview">
        <div className={styles.heroEyebrow}>Organization Database Console</div>
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
            Open Dashboard <span aria-hidden="true">→</span>
          </Link>
        </div>

        <ProductShowcase />
      </section>

      <CapabilitiesSection />

      <WhyNanogresSection />

      <section aria-labelledby="cta-title" className={styles.bottomCta}>
        <h2 id="cta-title">Ready to work with your databases?</h2>
        <p>
          Launch Nanogres Studio to explore your PostgreSQL databases, run queries, or configure
          scheduled snapshots.
        </p>
        <div className={styles.bottomCtaActions}>
          <Link className={styles.ctaPrimary} href="/login">
            Open Dashboard <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <Image alt="" height={20} src="/brand-icon.png" width={20} />
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
          <Link className={styles.footerLink} href="/privacy">
            Privacy policy
          </Link>
        </div>
      </footer>
    </main>
  );
}
