import Image from "next/image";
import Link from "next/link";
import { ThemeControl } from "@/components/theme/theme-control";
import styles from "./welcome.module.css";

export default function WelcomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Nanogres home">
          <Image src="/icon.svg" width={38} height={38} alt="" />
          <span>nanogres</span>
        </Link>
        <div className={styles.actions}>
          <ThemeControl />
          <Link className={styles.signIn} href="/login">
            Sign in
          </Link>
        </div>
      </header>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>YOUR POSTGRES, UNDER YOUR CONTROL</p>
        <h1>A clearer home for your databases.</h1>
        <p className={styles.intro}>
          Manage your project databases, access, and recovery from one private workspace. Your
          Postgres stays on your server.
        </p>
        <Link className={styles.cta} href="/login">
          Open your workspace <span aria-hidden="true">→</span>
        </Link>
      </section>
      <section className={styles.features} aria-label="What you can do">
        <article>
          <span>01</span>
          <h2>See what is running</h2>
          <p>Keep database size, connections, and server capacity in view.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Keep access intentional</h2>
          <p>Create database-scoped login roles for your applications.</p>
        </article>
        <article>
          <span>03</span>
          <h2>Plan for recovery</h2>
          <p>Review backups, download a copy, and restore into a new database.</p>
        </article>
      </section>
      <footer className={styles.footer}>Nanogres · A private workspace for Postgres</footer>
    </main>
  );
}
