// GET /api/agent-pass/status?sessionId: pending / approved / denied, for /pay to poll (backup to postMessage).
import { SessionId } from "@cpay/protocol";
import { fail, ok } from "../../../../lib/server/respond.js";
import { getAgentPass } from "../../../../lib/server/runs.js";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const sessionId = SessionId.safeParse(new URL(req.url).searchParams.get("sessionId"));
  if (!sessionId.success) return fail(400, "bad_request", "bad sessionId");
  const s = getAgentPass(sessionId.data);
  return ok({ state: s?.state ?? "none", reason: s?.reason ?? "" });
}
