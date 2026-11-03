import { NextRequest, NextResponse } from "next/server";
import {
  getPerministerConfig,
  SESSION_COOKIE,
  validatePerministerSession,
} from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!getPerministerConfig()) {
    return NextResponse.json(
      { error: "Authentication is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const session = await validatePerministerSession(token);
  if (!session) {
    const response = NextResponse.json(
      { authenticated: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  return NextResponse.json(
    {
      authenticated: true,
      account: session.account,
      organizations: session.organizations,
      session: session.session,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
