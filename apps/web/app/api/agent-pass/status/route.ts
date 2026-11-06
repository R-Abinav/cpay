// POST /api/agent-pass/status {attempt, action:"poll"|"cancel"}
//   poll:   "pending" while the human is in World App, then the final result (link: subHash; approve: the
//           signed single-use approval token) exactly once.
//   cancel: the phone pressed Stop; drop the pending attempt so a late approval signs nothing.
// The attempt id is in the body, not the query string, so access logs never record it.
import { cancelAgentPass, takeAgentPassResult } from "@cpay/world";
import { AgentPassStatusBody } from "../../../../lib/api.js";
import { fail, ok } from "../../../../lib/server/respond.js";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = AgentPassStatusBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return fail(400, "bad_request", "bad attempt");
  const { attempt, action } = body.data;
  if (action === "cancel") return ok({ cancelled: cancelAgentPass(attempt) });

  const s = takeAgentPassResult(attempt);
  if (s.state !== "done") return ok({ state: s.state });
  const out: Record<string, unknown> = { state: "done", approved: s.approved, reason: s.reason };
  if (s.mode) out.mode = s.mode;
  if (s.approved) {
    out.subHash = s.subHash;
    if (s.mode === "approve") out.token = s.token;
  }
  return ok(out);
}
