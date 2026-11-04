"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPerministerConfig, loginWithPerminister, SESSION_COOKIE } from "@/lib/perminister-auth";

export async function passwordLoginAction(formData: FormData): Promise<void> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!identifier || identifier.length > 254 || !password || password.length > 1024) {
    redirect("/login?error=invalid");
  }

  const config = getPerministerConfig();
  if (!config) redirect("/login?error=setup");

  const result = await loginWithPerminister(config, identifier, password);
  if (!result.success) redirect(`/login?error=${result.error}`);

  const maxAge = Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000);
  if (maxAge <= 0) redirect("/login?error=unavailable");

  (await cookies()).set(SESSION_COOKIE, result.sessionToken, {
    httpOnly: true,
    secure: config.appOrigin.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge,
    expires: new Date(result.expiresAt),
  });

  redirect("/overview");
}
