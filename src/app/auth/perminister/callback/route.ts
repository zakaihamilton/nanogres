import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getAppOrigin,
  getPerministerConfig,
  isPerministerSessionGrant,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  SESSION_COOKIE,
} from "@/lib/perminister-auth";

export const runtime = "nodejs";

function stateMatches(received: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
  );
}

function loginError(request: NextRequest, code: "setup" | "denied" | "callback"): NextResponse {
  const origin = getAppOrigin() ?? request.nextUrl.origin;
  const response = NextResponse.redirect(new URL(`/login?error=${code}`, origin));
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_VERIFIER_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = getPerministerConfig();
  const appOrigin = getAppOrigin();
  if (!config || !appOrigin) return loginError(request, "setup");

  const query = request.nextUrl.searchParams;
  if (query.has("error")) return loginError(request, "denied");

  const code = query.get("code") ?? "";
  const receivedState = query.get("state") ?? "";
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value;
  if (!code || code.length > 2048 || !verifier || !stateMatches(receivedState, expectedState)) {
    return loginError(request, "callback");
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(`${config.baseUrl}/api/auth/consumer/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Perminister-Client-Id": config.clientId,
        "X-Perminister-Client-Secret": config.clientSecret,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return loginError(request, "callback");
  }

  if (!tokenResponse.ok) return loginError(request, "callback");
  let body: unknown;
  try {
    body = await tokenResponse.json();
  } catch {
    return loginError(request, "callback");
  }
  if (!isPerministerSessionGrant(body)) return loginError(request, "callback");

  const maxAge = Math.floor((Date.parse(body.session.expiresAt) - Date.now()) / 1000);
  if (maxAge <= 0) return loginError(request, "callback");

  const response = NextResponse.redirect(new URL("/overview", appOrigin));
  response.cookies.set(SESSION_COOKIE, body.sessionToken, {
    httpOnly: true,
    secure: appOrigin.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge,
    expires: new Date(body.session.expiresAt),
  });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_VERIFIER_COOKIE);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
