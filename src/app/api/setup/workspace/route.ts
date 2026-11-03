import { NextRequest, NextResponse } from "next/server";
import {
  getAppOrigin,
  getCurrentPerministerSession,
  getNanogresWorkspaceContext,
} from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const appOrigin = getAppOrigin();
  if (!appOrigin || request.headers.get("origin") !== appOrigin) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }

  const session = await getCurrentPerministerSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const context = getNanogresWorkspaceContext(session);
  if (context instanceof Response) return context;
  const { config, organizationId, workspaceId } = context;

  try {
    const response = await fetch(`${config.baseUrl}/api/auth/consumer/workspaces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        "X-Perminister-Client-Id": config.clientId,
        "X-Perminister-Client-Secret": config.clientSecret,
      },
      body: JSON.stringify({ organizationId, workspaceId }),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (response.ok) {
      return NextResponse.json({ granted: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        {
          error:
            "Perminister requires an organization owner or admin to initialize this workspace.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Perminister is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Perminister is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
