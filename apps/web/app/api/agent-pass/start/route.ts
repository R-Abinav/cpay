// POST /api/agent-pass/start {mode:"link"} | {mode:"approve", binding:{sessionId, amount, token, to}, subHash}
// Begins a World Agent Pass step-up (OIDC, PKCE, max_age=0, essential acr). The binding stays in this
// server's memory, keyed by the attempt; nothing is persisted or logged. Returns the World URL + attempt id.
import { startAgentPass } from "@cpay/world";
import { AgentPassStartBody } from "../../../../lib/api.js";
import { agentPassConfig } from "../../../../lib/server/config.js";
import { fail, failFromError, ok } from "../../../../lib/server/respond.js";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = AgentPassStartBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return fail(400, "bad_request", "bad agent pass request");
  try {
    const r = await startAgentPass(agentPassConfig(), body.data);
    return ok({ url: r.url, attempt: r.state });
  } catch (e) {
    return failFromError(e, "agent-pass", null);
  }
}
