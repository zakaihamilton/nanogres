import { callNanogresWorkloadApi } from "@/lib/nanogres-api";
import {
  type WorkloadIdentityFailureReason,
  type WorkloadIdentityGrant,
  verifyWorkloadIdentityToken,
} from "@/lib/workload-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type IdentityList = { identities?: WorkloadIdentityGrant[] };

async function readLimitedBody(request: Request, limit: number): Promise<string | null> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > limit) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function POST(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || token.length > 8192) {
    return Response.json({ error: "A workload identity token is required." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const text = await readLimitedBody(request, 4096);
    if (text === null) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid request body.");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const database = typeof body.database === "string" ? body.database : "";
  const role = typeof body.role === "string" ? body.role : "";
  const sshPublicKey = typeof body.sshPublicKey === "string" ? body.sshPublicKey.trim() : "";
  if (!organizationId || !database || !role || sshPublicKey.length > 1024 || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]{1,128})?$/.test(sshPublicKey)) {
    return Response.json(
      { error: "Organization, database, role, and an Ed25519 SSH public key are required." },
      { status: 400 },
    );
  }

  const grantResponse = await callNanogresWorkloadApi(
    "/v1/workload-identities",
    organizationId,
  );
  if (!grantResponse.ok) {
    return Response.json({ error: "Nanogres could not load workload identity grants." }, { status: 503 });
  }
  const grantData = (await grantResponse.json().catch(() => null)) as IdentityList | null;
  const candidates = (grantData?.identities ?? []).filter(
    (grant) => grant.database === database && grant.role === role,
  );
  let acceptedGrant: WorkloadIdentityGrant | undefined;
  const verificationFailures: WorkloadIdentityFailureReason[] = [];
  for (const grant of candidates) {
    if (
      await verifyWorkloadIdentityToken(token, grant, (reason) => verificationFailures.push(reason))
    ) {
      acceptedGrant = grant;
      break;
    }
  }
  if (!acceptedGrant) {
    console.warn("Nanogres rejected a workload identity token.", {
      database,
      role,
      candidateCount: candidates.length,
      reasons: [...new Set(verificationFailures)],
    });
    return Response.json(
      { error: "This workload identity has no matching Nanogres grant." },
      { status: 403 },
    );
  }

  const issued = await callNanogresWorkloadApi(
    "/v1/workload-certificates",
    organizationId,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantId: acceptedGrant.id, database, role, sshPublicKey }),
    },
  );
  if (!issued.ok) {
    return Response.json(
      { error: "Nanogres could not issue workload SSH credentials." },
      { status: issued.status >= 500 ? 503 : issued.status },
    );
  }
  return new Response(issued.body, {
    status: issued.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
