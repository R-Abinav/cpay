// POST /api/transcribe: audio -> 0G STT (private) -> {text}. Used for the spoken confirm code; the PHONE
// matches "confirm <code>" in deterministic code. The text is returned to the caller only, never logged
// or stored. Any 0G failure is a safe-stop.
import { guardZg, json, publicEvidence, readAudio, zgClient, zgFailure } from "../../../lib/server/zg.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const denied = guardZg(req, "/api/transcribe");
  if (denied) return denied;
  const audio = await readAudio(req);
  if (!audio.ok) return audio.res;
  try {
    const t = await zgClient().transcribe(audio.bytes, { filename: audio.filename });
    return json({ text: t.text, requestId: t.requestId, evidence: [publicEvidence(t.evidence)] });
  } catch (e) {
    return zgFailure(e);
  }
}
