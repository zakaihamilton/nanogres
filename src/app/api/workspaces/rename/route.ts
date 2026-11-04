import { NextRequest, NextResponse } from "next/server";
import {
  getCurrentPerministerSession,
  getNanogresWorkspaceContext,
  WORKSPACE_COOKIE,
  WORKSPACE_NAMES_COOKIE,
} from "@/lib/perminister-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getCurrentPerministerSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  let body: {
    workspaceId?: string;
    newWorkspaceId?: string;
    name?: string;
    organizationId?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { workspaceId, newWorkspaceId, name, organizationId } = body;
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required." }, { status: 400 });
  }

  const targetSlug = newWorkspaceId?.trim().toLowerCase();
  const isSlugChange = targetSlug && targetSlug !== workspaceId.toLowerCase();

  const rawNames = request.cookies.get(WORKSPACE_NAMES_COOKIE)?.value;
  let names: Record<string, string> = {};
  if (rawNames) {
    try {
      names = JSON.parse(rawNames) as Record<string, string>;
    } catch {
      // ignore
    }
  }

  const cleanName = name?.trim();
  const effectiveId = isSlugChange ? targetSlug : workspaceId;

  if (isSlugChange) {
    const context = await getNanogresWorkspaceContext(session);
    if (context instanceof Response) return context;
    const { config } = context;
    const orgId = organizationId || context.organizationId;

    try {
      // 1. Register new slug in Perminister
      const regRes = await fetch(`${config.baseUrl}/api/auth/consumer/workspaces`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
          "X-Perminister-Client-Id": config.clientId,
          "X-Perminister-Client-Secret": config.clientSecret,
        },
        body: JSON.stringify({ organizationId: orgId, workspaceId: targetSlug }),
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      });

      if (!regRes.ok) {
        const errPayload = await regRes.json().catch(() => ({}));
        const errMsg =
          typeof errPayload?.error === "string"
            ? errPayload.error
            : "Could not register new slug in Perminister.";
        return NextResponse.json({ error: errMsg }, { status: regRes.status });
      }

      // 2. Revoke old slug in Perminister (best effort)
      try {
        await fetch(
          `${config.baseUrl}/api/auth/consumer/workspaces/${encodeURIComponent(workspaceId)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${session.token}`,
              "Content-Type": "application/json",
              "X-Perminister-Client-Id": config.clientId,
              "X-Perminister-Client-Secret": config.clientSecret,
            },
            body: JSON.stringify({ organizationId: orgId }),
            cache: "no-store",
            signal: AbortSignal.timeout(6_000),
          },
        );
      } catch {
        // ignore deletion errors on old slug
      }

      // Migrate custom names
      if (cleanName) {
        names[targetSlug] = cleanName;
      } else if (names[workspaceId]) {
        names[targetSlug] = names[workspaceId];
      }
      delete names[workspaceId];
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Perminister is temporarily unavailable to rename slug.",
        },
        { status: 503 },
      );
    }
  } else {
    // Only name changed
    if (cleanName) {
      names[workspaceId] = cleanName;
    } else {
      delete names[workspaceId];
    }
  }

  const res = NextResponse.json(
    { success: true, workspaceId: effectiveId, name: names[effectiveId] ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );

  if (isSlugChange) {
    res.cookies.set(WORKSPACE_COOKIE, effectiveId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  res.cookies.set(WORKSPACE_NAMES_COOKIE, JSON.stringify(names), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return res;
}
