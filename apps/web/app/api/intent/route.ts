// POST /api/intent: earbud audio -> 0G whisper (private) -> text -> 0G intent model (private) -> {amount, token}.
// The LLM only proposes; this handler validates, and nothing here can pay. Every 0G call's evidence is kept.
import { createRouterClient } from "@cpay/zerog";
import { RunId } from "../../../lib/api.js";
import { routerOptions } from "../../../lib/server/config.js";
import { fail, failFromError, ok } from "../../../lib/server/respond.js";
import { getRun, keepEvidence, stamp } from "../../../lib/server/runs.js";
import { findToken, knownTokens, parseAmount } from "../../../lib/units.js";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "bad_request", "expected multipart form data");
  }
  const runId = RunId.safeParse(form.get("runId"));
  const audio = form.get("audio");
  if (!runId.success) return fail(400, "bad_request", "bad runId");
  if (!(audio instanceof Blob) || audio.size === 0) return fail(400, "bad_request", "missing audio");
  if (audio.size > MAX_AUDIO_BYTES) return fail(413, "bad_request", "audio too large");

  const run = getRun(runId.data);
  stamp(run, "intentStart");

  let client;
  try {
    client = createRouterClient(routerOptions());
  } catch (e) {
    return failFromError(e, "zerog", run);
  }

  // Ears
  let text: string;
  try {
    const t = await client.transcribe(audio);
    await keepEvidence(run, t.evidence);
    text = t.text;
  } catch (e) {
    return failFromError(e, "zerog", run);
  }
  stamp(run, "transcribed");

  // Brain
  let result;
  try {
    result = await client.parseIntent(text);
    await keepEvidence(run, result.evidence);
  } catch (e) {
    return failFromError(e, "zerog", run);
  }
  stamp(run, "intentParsed");

  const requestIds = run.evidence.map((e) => e.requestId).filter((x): x is string => !!x);
  if (result.refused) {
    run.decision = "refused";
    return fail(422, "refused", result.reason, { dependency: "zerog", evidence: run.evidence });
  }

  // Deterministic validation of what the model proposed. Anything off is a refusal, not a guess.
  const token = findToken(knownTokens(process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"), result.intent.token);
  if (!token) {
    run.decision = "refused";
    return fail(422, "refused", `unsupported token ${result.intent.token}`, { evidence: run.evidence });
  }
  let amountBase: bigint;
  try {
    amountBase = parseAmount(result.intent.amount, token.decimals);
    if (amountBase <= 0n) throw new Error("amount must be positive");
  } catch (e) {
    run.decision = "refused";
    return fail(422, "refused", (e as Error).message, { evidence: run.evidence });
  }
  if (result.intent.mode !== "lite") {
    run.decision = "refused";
    return fail(422, "refused", "full (Railgun) mode is roadmap; only lite payments are enabled", { evidence: run.evidence });
  }

  run.intent = { amount: result.intent.amount, token: token.symbol, mode: result.intent.mode, amountBase: amountBase.toString() };
  return ok({
    runId: run.id,
    transcript: text,
    intent: { amount: result.intent.amount, token: token.symbol, mode: result.intent.mode },
    token: { symbol: token.symbol, address: token.address, decimals: token.decimals },
    amountBase: amountBase.toString(),
    requestIds,
    evidence: run.evidence,
  });
}
