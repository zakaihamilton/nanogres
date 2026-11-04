import Image from "next/image";
import { ThemeControl } from "@/components/theme/theme-control";
import { getPerministerRecoveryUrl, isPerministerConfigured } from "@/lib/perminister-auth";
import { passwordLoginAction } from "./actions";
import styles from "./login.module.css";

const messages: Record<string, string> = {
  setup: "Sign-in is not configured yet. Add the Perminister app client to the server environment.",
  denied: "Sign-in was cancelled. You can try again when you’re ready.",
  callback: "We couldn’t complete sign-in. Please start again.",
  invalid: "We couldn’t sign you in. Check your email or username and password, then try again.",
  rate_limited: "Too many sign-in attempts. Wait a moment before trying again.",
  unavailable: "Perminister is temporarily unavailable. Try again in a moment.",
};

function FeatureIcon({ kind }: { kind: "database" | "access" | "backup" }) {
  if (kind === "database") {
    return (
      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7" />
      </svg>
    );
  }
  if (kind === "access") {
    return (
      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="4" />
        <path d="M2.5 21v-2a6.5 6.5 0 0 1 13 0v2M19 8v8M23 12h-8" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </svg>
  );
}

function SecurityIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; loggedOut?: string | string[] }>;
}) {
  const query = await searchParams;
  const configured = isPerministerConfigured();
  const recoveryUrl = configured ? getPerministerRecoveryUrl() : null;
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  const loggedOut = Array.isArray(query.loggedOut) ? query.loggedOut[0] : query.loggedOut;
  const message = error ? messages[error] : undefined;

  return (
    <main className={styles.page}>
      <div className={styles.themeControl}>
        <ThemeControl />
      </div>
      <div className={styles.layout}>
        <section aria-labelledby="welcome-title" className={styles.intro}>
          <div className={styles.brand}>
            <Image alt="" className={styles.brandMark} src="/icon.svg" width={32} height={32} />
            <span>nanogres</span>
          </div>

          <div className={styles.introBody}>
            <p className={styles.eyebrow}>POSTGRES FOR YOUR PROJECTS</p>
            <h1 id="welcome-title">A clearer home for your Postgres databases.</h1>
            <p className={styles.introDescription}>
              Keep the essentials close: project databases, access roles, and recoverable backups
              for the Postgres server you manage.
            </p>

            <ul className={styles.featureList}>
              <li>
                <span className={styles.featureIcon}>
                  <FeatureIcon kind="database" />
                </span>
                <span>
                  <strong>Know what is running</strong>
                  <small>See database health, size, and active connections.</small>
                </span>
              </li>
              <li>
                <span className={styles.featureIcon}>
                  <FeatureIcon kind="access" />
                </span>
                <span>
                  <strong>Keep access intentional</strong>
                  <small>Manage project roles with permissions checked on every action.</small>
                </span>
              </li>
              <li>
                <span className={styles.featureIcon}>
                  <FeatureIcon kind="backup" />
                </span>
                <span>
                  <strong>Recover with confidence</strong>
                  <small>Download a dump or restore a trusted file into a new database.</small>
                </span>
              </li>
            </ul>
          </div>

          <div className={styles.architectureCard}>
            <div className={styles.architectureHeading}>
              <span>Private by design</span>
              <span className={styles.privateLabel}>SERVER-SIDE ACCESS</span>
            </div>
            <div
              aria-label="Your browser connects to the Nanogres server, which manages Postgres in your workspace."
              className={styles.architectureFlow}
              role="img"
            >
              <span className={styles.architectureNode}>
                <small>YOU</small>
                <strong>Dashboard</strong>
              </span>
              <span aria-hidden="true" className={styles.architectureArrow}>
                →
              </span>
              <span className={`${styles.architectureNode} ${styles.architectureNodeAccent}`}>
                <small>SECURE API</small>
                <strong>Nanogres</strong>
              </span>
              <span aria-hidden="true" className={styles.architectureArrow}>
                →
              </span>
              <span className={styles.architectureNode}>
                <small>WORKSPACE</small>
                <strong>Postgres</strong>
              </span>
            </div>
            <p>
              Postgres stays protected in your workspace. The browser never receives internal API
              tokens.
            </p>
          </div>
          <p className={styles.footer}>Built for personal projects and small teams.</p>
        </section>

        <section aria-labelledby="login-title" className={styles.card}>
          <div className={styles.loginIcon}>
            <FeatureIcon kind="database" />
          </div>
          <p className={styles.loginEyebrow}>WORKSPACE ACCESS</p>
          <h2 id="login-title">Welcome back.</h2>
          <p className={styles.description}>
            Use your Perminister email or username and password, or continue with single sign-on.
          </p>

          {message ? (
            <p className={styles.notice} role="alert">
              {message}
            </p>
          ) : null}
          {loggedOut ? (
            <p className={styles.notice} role="status">
              You’re signed out.
            </p>
          ) : null}

          {configured ? (
            <>
              <form action={passwordLoginAction} className={styles.credentialsForm}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Email or username</span>
                  <input
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className={styles.input}
                    maxLength={254}
                    name="identifier"
                    required
                    spellCheck={false}
                    type="text"
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Password</span>
                  <input
                    autoComplete="current-password"
                    className={styles.input}
                    maxLength={1024}
                    name="password"
                    required
                    type="password"
                  />
                </label>
                {recoveryUrl ? (
                  <a className={styles.recoveryLink} href={recoveryUrl}>
                    Forgot password?
                  </a>
                ) : null}
                <button className={styles.signInButton} type="submit">
                  Sign in
                  <span aria-hidden="true">→</span>
                </button>
              </form>

              <div aria-hidden="true" className={styles.divider}>
                <span>OR</span>
              </div>

              <a className={styles.singleSignOnButton} href="/api/auth/login">
                Continue with Perminister
                <span aria-hidden="true">↗</span>
              </a>
            </>
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
            <span className={styles.securityIcon}>
              <SecurityIcon />
            </span>
            <span>
              <strong>Your session stays private</strong>
              <small>
                Perminister verifies your credentials. Nanogres checks workspace permissions on the
                server.
              </small>
            </span>
          </div>
          <p className={styles.signInFootnote}>
            Your password is checked by Perminister and is never stored by Nanogres.
          </p>
        </section>
      </div>
    </main>
  );
}
