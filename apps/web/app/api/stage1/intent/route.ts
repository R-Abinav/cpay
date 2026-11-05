// POST /api/stage1/intent (Stage 1 dev page): typed prompt -> 0G intent model -> {amount, token}.
// Same code path as /api/intent: @cpay/zerog parseIntent, real request ID + receipt, the trust mode we
// actually sent. No fallback: any 0G failure is a safe-stop (503 zg_unavailable, UI "BRAIN OFFLINE").
// The recipient never goes to 0G: the destination comes only from the scanned QR, on the client.
import { z } from "zod";
import { publicEvidence, guardZg, json, zgClient, zgFailure } from "../../../../lib/server/zg.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `recipient` may be sent by older clients; it is accepted and ignored (never forwarded).
const Body = z.object({ prompt: z.string().trim().min(1).max(300) });
// The Stage 1 page settles in ETH or USDC; the main flow uses AGENT_ALLOWED_TOKENS.
const STAGE1_TOKENS = ["USDC", "ETH"] as const;

export async function POST(req: Request): Promise<Response> {
  const denied = guardZg(req, "/api/stage1/intent");
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", detail: "prompt must be 1-300 chars" }, 400);

  let r;
  try {
    r = await zgClient({ tokenAllowList: STAGE1_TOKENS }).parseIntent(parsed.data.prompt);
  } catch (e) {
    return zgFailure(e);
  }
  const ev = publicEvidence(r.evidence);
  const meta = {
    requestId: r.requestId,
    model: ev.model,
    trustMode: ev.trustMode,
    provider: ev.provider,
    resKey: ev.resKey,
    receiptStatus: ev.receiptStatus,
    teeVerified: ev.teeVerified,
    evidence: [ev],
  };
  if (r.refused) return json({ error: "refused", reason: r.reason, ...meta }, 422);
  return json({ success: true, intent: { amount: r.intent.amount, token: r.intent.token }, ...meta });
}
