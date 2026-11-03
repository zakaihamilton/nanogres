import Link from "next/link";
import { ThemeControl } from "@/components/theme/theme-control";
import { isPerministerConfigured } from "@/lib/perminister-auth";
import styles from "./login.module.css";

const messages: Record<string, string> = {
  setup: "Sign-in is not configured yet. Add the Perminister app client to the server environment.",
  denied: "Sign-in was cancelled. You can try again when you’re ready.",
  callback: "We couldn’t complete sign-in. Please start again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; loggedOut?: string | string[] }>;
}) {
  const query = await searchParams;
  const configured = isPerministerConfigured();
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  const loggedOut = Array.isArray(query.loggedOut) ? query.loggedOut[0] : query.loggedOut;
  const message = error ? messages[error] : undefined;

  return (
    <main className={styles.page}>
      <div className={styles.themeControl}>
        <ThemeControl />
      </div>
      <section aria-labelledby="login-title" className={styles.card}>
        <Link aria-label="Nanogres home" className={styles.brand} href="/">
          <span aria-hidden="true" className={styles.brandMark}>
            <span />
            <span />
            <span />
          </span>
          <span>nanogres</span>
        </Link>
        <div className={styles.iconWrap}>
          <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
            <path d="M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7" />
            <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
          </svg>
        </div>
        <p className={styles.eyebrow}>PRIVATE POSTGRES CONTROL</p>
        <h1 id="login-title">Your databases, in one place.</h1>
        <p className={styles.description}>
          Sign in with your Perminister account to manage the Postgres services connected to
          Nanogres.
        </p>

        {message ? <p className={styles.notice}>{message}</p> : null}
        {loggedOut ? <p className={styles.notice}>You’re signed out.</p> : null}

        {configured ? (
          <a className={styles.signInButton} href="/api/auth/login">
            Continue with Perminister
            <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <button className={styles.signInButton} disabled type="button">
            Perminister sign-in not configured
          </button>
        )}

        {!configured ? (
          <p className={styles.setupHint}>
            Set the app client ID, secret, and origin in the server environment to enable sign-in.
          </p>
        ) : null}

        <div className={styles.securityNote}>
          <span aria-hidden="true" className={styles.securityIcon}>
            <svg fill="none" viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <span>
            <strong>Private by design</strong>
            <small>
              Perminister verifies your identity. Your session stays in a secure, HttpOnly cookie.
            </small>
          </span>
        </div>
      </section>
      <p className={styles.footer}>Nanogres · Postgres control plane</p>
    </main>
  );
}
