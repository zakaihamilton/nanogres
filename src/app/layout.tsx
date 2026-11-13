import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { ThemeProvider } from "panel-frame-ui";
import { THEME_COOKIE, THEMES, type Theme } from "@/lib/theme";
import "./globals.css";

const themePersistence = { type: "cookie" as const, name: THEME_COOKIE };

export const metadata: Metadata = {
  title: {
    default: "Nanogres",
    template: "%s · Nanogres",
  },
  description:
    "A private dashboard for managing organization-scoped Postgres databases, access roles, and backups.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = THEMES.includes(cookieTheme as Theme) ? (cookieTheme as Theme) : "system";

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body>
        <ThemeProvider
          initialTheme={theme}
          persistence={themePersistence}
          systemMode="system"
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
