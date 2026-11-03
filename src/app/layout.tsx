import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { THEME_COOKIE, THEMES, type Theme } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Nanogres",
    template: "%s · Nanogres",
  },
  description: "A private control panel for your Postgres databases.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = THEMES.includes(cookieTheme as Theme) ? (cookieTheme as Theme) : "system";

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
