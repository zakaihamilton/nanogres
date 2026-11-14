import { NextRequest, NextResponse } from "next/server";
import { getAppOrigin, getPerministerConfig } from "@/lib/perminister-auth";
import {
  createPerministerSsoTransaction,
  perministerSsoCookieName,
  safeNanogresReturnTo,
  sealPerministerSsoTransaction,
} from "@/lib/perminister-sso";

export const runtime = "nodejs";
const SSO_COOKIE_MAX_AGE = 10 * 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = getPerministerConfig();
  const appOrigin = getAppOrigin();
  const next = safeNanogresReturnTo(request.nextUrl.searchParams.get("next"));
  if (!config || !appOrigin) {
    const error = new URLSearchParams({ error: "setup" });
    if (next) error.set("next", next);
    return NextResponse.redirect(new URL(`/login?${error}`, appOrigin ?? request.nextUrl.origin));
  }

  const generated = createPerministerSsoTransaction();
  const redirectUri = new URL("/auth/perminister/callback", config.appOrigin).toString();
  const authorizeUrl = new URL("/oauth/authorize", config.baseUrl);
  const prompt = request.nextUrl.searchParams.get("prompt") === "login" ? "login" : undefined;
  authorizeUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email perminister_api",
    state: generated.state,
    nonce: generated.nonce,
    ...(prompt ? { prompt } : {}),
    code_challenge: generated.challenge,
    code_challenge_method: "S256",
  }).toString();

  const transaction = {
    state: generated.state,
    verifier: generated.verifier,
    nonce: generated.nonce,
    redirectUri,
    returnTo: next,
  };
  const cookieName = perministerSsoCookieName(transaction.state);
  if (!cookieName) {
    return NextResponse.redirect(new URL("/login?error=callback", appOrigin));
  }

  const response = NextResponse.redirect(authorizeUrl, 302);
  response.cookies.set(
    cookieName,
    sealPerministerSsoTransaction(transaction, config.clientSecret),
    {
      httpOnly: true,
      secure: config.appOrigin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: SSO_COOKIE_MAX_AGE,
    },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
