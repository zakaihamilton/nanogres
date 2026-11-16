import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { exchangePerministerOidcCode } from "@/lib/perminister-oidc";
import {
  getAppOrigin,
  getPerministerConfig,
  nanogresOrganizations,
  ORGANIZATION_COOKIE,
  SESSION_COOKIE,
  validatePerministerSession,
} from "@/lib/perminister-auth";
import {
  matchesPerministerSsoState,
  perministerSsoCookieName,
  readPerministerSsoTransaction,
  safeNanogresReturnTo,
} from "@/lib/perminister-sso";

export const runtime = "nodejs";

function loginError(
  request: NextRequest,
  code: "setup" | "denied" | "callback",
  state = "",
  returnTo: string | null = null,
): NextResponse {
  const query = new URLSearchParams({ error: code });
  const safeReturn = safeNanogresReturnTo(returnTo);
  if (safeReturn) query.set("next", safeReturn);
  const origin = getAppOrigin() ?? request.nextUrl.origin;
  const response = NextResponse.redirect(new URL(`/login?${query}`, origin));
  const cookieName = perministerSsoCookieName(state);
  if (cookieName) {
    response.cookies.set(cookieName, "", {
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = getPerministerConfig();
  const appOrigin = getAppOrigin();
  if (!config || !appOrigin) return loginError(request, "setup");

  const query = request.nextUrl.searchParams;
  const state = query.get("state") ?? "";
  if (query.getAll("state").length !== 1) return loginError(request, "callback", state);

  const cookieName = perministerSsoCookieName(state);
  if (!cookieName) return loginError(request, "callback", state);
  const cookieJar = await cookies();
  const cookieValue = cookieJar.get(cookieName)?.value;
  const transaction = readPerministerSsoTransaction(cookieValue, config.clientSecret);
  if (!transaction || !matchesPerministerSsoState(transaction.state, state)) {
    return loginError(request, "callback", state);
  }

  const codes = query.getAll("code");
  if (query.has("error")) return loginError(request, "denied", state, transaction.returnTo);
  if (codes.length !== 1 || !codes[0] || codes[0].length > 2048) {
    return loginError(request, "callback", state, transaction.returnTo);
  }

  let accessToken: string;
  try {
    const grant = await exchangePerministerOidcCode({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: codes[0],
      codeVerifier: transaction.verifier,
      nonce: transaction.nonce,
      redirectUri: transaction.redirectUri,
    });
    accessToken = grant.accessToken;
  } catch {
    return loginError(request, "callback", state, transaction.returnTo);
  }

  const session = await validatePerministerSession(accessToken, config);
  if (!session) return loginError(request, "callback", state, transaction.returnTo);

  const availableOrganizations = nanogresOrganizations({ ...session, token: accessToken });
  const currentOrganizationId = cookieJar
    .get(ORGANIZATION_COOKIE)
    ?.value?.trim()
    .toLowerCase();
  const selectedOrganization =
    availableOrganizations.find(
      (organization) => organization.organizationId === currentOrganizationId,
    ) ?? availableOrganizations[0];

  const expiresAt = Date.parse(session.session.expiresAt);
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
  if (!Number.isFinite(expiresAt) || maxAge <= 0) {
    return loginError(request, "callback", state, transaction.returnTo);
  }

  const response = NextResponse.redirect(
    new URL(transaction.returnTo ?? "/overview", appOrigin),
    303,
  );
  response.cookies.set(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    secure: appOrigin.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge,
    expires: new Date(expiresAt),
  });
  const organizationCookieOptions = {
    httpOnly: true,
    secure: appOrigin.startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };
  if (selectedOrganization) {
    response.cookies.set(
      ORGANIZATION_COOKIE,
      selectedOrganization.organizationId,
      organizationCookieOptions,
    );
  } else {
    response.cookies.set(ORGANIZATION_COOKIE, "", {
      ...organizationCookieOptions,
      maxAge: 0,
    });
  }
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    secure: appOrigin.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
