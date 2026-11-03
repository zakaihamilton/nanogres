import { NextRequest, NextResponse } from "next/server";
import { getAppOrigin, revokePerministerSession, SESSION_COOKIE } from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) await revokePerministerSession(token);

  const origin = getAppOrigin() ?? request.nextUrl.origin;
  const response = NextResponse.redirect(new URL("/login?loggedOut=1", origin), 303);
  response.cookies.delete(SESSION_COOKIE);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
