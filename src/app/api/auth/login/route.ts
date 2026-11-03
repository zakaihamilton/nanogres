import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getAppOrigin,
  getPerministerConfig,
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
} from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = getPerministerConfig();
  const appOrigin = getAppOrigin();
  if (!config || !appOrigin) {
    return NextResponse.redirect(
      new URL("/login?error=setup", appOrigin ?? request.nextUrl.origin),
    );
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = `${config.appOrigin}/auth/perminister/callback`;
  const authorizeUrl = new URL("/oauth/authorize", config.baseUrl);
  authorizeUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callback,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const response = NextResponse.redirect(authorizeUrl);
  const secure = config.appOrigin.startsWith("https:");
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: OAUTH_COOKIE_MAX_AGE,
  };
  response.cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions);
  response.cookies.set(OAUTH_VERIFIER_COOKIE, verifier, cookieOptions);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
