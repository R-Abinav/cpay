// GET /api/agent-pass/start?runId&sessionId&amount(base units)&token(address): begin a World Agent Pass step-up (OIDC, PKCE,
// max_age=0, essential acr) for exactly this payment. Validated by our own callback, not the issuer.
import { startAgentPass } from "@cpay/world";
import { RunId } from "../../../../lib/api.js";
import { Address, SessionId, UintString } from "@cpay/protocol";
import { agentPassConfig } from "../../../../lib/server/config.js";
import { fail, failFromError, ok } from "../../../../lib/server/respond.js";
import { getRun, setAgentPass, stamp } from "../../../../lib/server/runs.js";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const runId = RunId.safeParse(q.get("runId"));
  const sessionId = SessionId.safeParse(q.get("sessionId"));
  const amount = UintString.safeParse(q.get("amount"));
  const token = Address.safeParse(q.get("token"));
  if (!runId.success || !sessionId.success || !amount.success || !token.success) {
    return fail(400, "bad_request", "bad agent pass request");
  }
  const run = getRun(runId.data);
  // Binding token = the ERC-20 address, lowercased (as @cpay/world normalises it).
  const binding = { sessionId: sessionId.data, amount: amount.data, token: token.data.toLowerCase() };
  try {
    const r = await startAgentPass(agentPassConfig(), binding);
    setAgentPass(sessionId.data, { state: "pending", reason: "waiting for approval in World App", binding });
    stamp(run, "agentPassStarted");
    return ok({ url: r.url });
  } catch (e) {
    return failFromError(e, "agent-pass", run);
  }
}
