// POST /api/intent: earbud audio (or typed text) -> 0G STT (if audio) -> 0G intent model -> {amount, token}.
// The model only PROPOSES; the phone's policy code decides and the QR picks the destination.
// The transcript is never returned, logged or stored. Any 0G failure is a safe-stop, never a guess.
import type { Evidence } from "@cpay/zerog";
import { z } from "zod";
import { guardZg, json, publicEvidence, readAudio, zgClient, zgFailure } from "../../../lib/server/zg.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TextBody = z.object({ text: z.string().trim().min(1).max(300) }).strict();

export async function POST(req: Request): Promise<Response> {
  const denied = guardZg(req, "/api/intent");
  if (denied) return denied;

  let client;
  try {
    client = zgClient();
  } catch (e) {
    return zgFailure(e);
  }

  const evidence: Evidence[] = [];
  let text: string;
  if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    const parsed = TextBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "bad_request", detail: "expected {text} (1-300 chars) or audio" }, 400);
    text = parsed.data.text;
  } else {
    const audio = await readAudio(req);
    if (!audio.ok) return audio.res;
    try {
      const t = await client.transcribe(audio.bytes, { filename: audio.filename });
      evidence.push(t.evidence);
      text = t.text.trim().slice(0, 1000);
    } catch (e) {
      return zgFailure(e, evidence);
    }
    // Silence: nothing to parse. A refusal (say the amount again), not a 0G call.
    if (!text) return json({ refusal: "empty_transcript", requestIds: evidence.map((e) => e.requestId), evidence: evidence.map(publicEvidence) });
  }

  try {
    const r = await client.parseIntent(text);
    evidence.push(r.evidence);
    const requestIds = evidence.map((e) => e.requestId);
    const ev = evidence.map(publicEvidence);
    if (r.refused) return json({ refusal: r.reason, requestIds, evidence: ev });
    return json({ intent: { amount: r.intent.amount, token: r.intent.token }, requestIds, evidence: ev });
  } catch (e) {
    return zgFailure(e, evidence);
  }
}
