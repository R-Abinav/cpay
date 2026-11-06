// GET /api/agent-pass/status?attempt: "pending" while the human is in World App, then the final result
// (link: subHash; approve: the signed single-use approval token) exactly once. POST {attempt} cancels.
import { cancelAgentPass, takeAgentPassResult } from "@cpay/world";
import { AgentPassAttempt } from "../../../../lib/api.js";
import { fail, ok } from "../../../../lib/server/respond.js";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const attempt = AgentPassAttempt.safeParse(new URL(req.url).searchParams.get("attempt"));
  if (!attempt.success) return fail(400, "bad_request", "bad attempt");
  const s = takeAgentPassResult(attempt.data);
  if (s.state !== "done") return ok({ state: s.state });
  const out: Record<string, unknown> = { state: "done", approved: s.approved, reason: s.reason };
  if (s.mode) out.mode = s.mode;
  if (s.approved) {
    out.subHash = s.subHash;
    if (s.mode === "approve") out.token = s.token;
  }
  return ok(out);
}

/** The phone pressed Stop: drop the pending attempt so a late approval signs nothing. */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { attempt?: unknown } | null;
  const attempt = AgentPassAttempt.safeParse(body?.attempt);
  if (!attempt.success) return fail(400, "bad_request", "bad attempt");
  return ok({ cancelled: cancelAgentPass(attempt.data) });
}
