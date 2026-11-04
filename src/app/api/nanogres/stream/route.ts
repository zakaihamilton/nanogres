import { authorizeNanogresAction } from "@/lib/perminister-auth";
import { actionFor } from "@/lib/nanogres-actions";
import { callNanogresApi } from "@/lib/nanogres-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(): Promise<Response> {
  const action = actionFor("GET", ["events", "stream"]);
  if (!action) {
    return Response.json({ error: "Route not found." }, { status: 404 });
  }

  const auth = await authorizeNanogresAction(action);
  if (auth instanceof Response) return auth;

  try {
    const upstream = await callNanogresApi("/v1/events/stream", auth.session, auth.workspace, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
    });

    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: "Could not open telemetry stream." },
        { status: upstream.status || 503 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return Response.json(
      { error: "Nanogres telemetry stream is currently unavailable." },
      { status: 503 },
    );
  }
}
