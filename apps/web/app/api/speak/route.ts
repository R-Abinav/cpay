// POST /api/speak: template id + validated numbers -> fixed template text -> 0G TTS -> mp3 for the earbuds.
// Never free text: the body schema only admits a template id, a decimal amount and a token symbol.
import { createRouterClient, replyText } from "@cpay/zerog";
import { SpeakRequest } from "../../../lib/api.js";
import { routerOptions } from "../../../lib/server/config.js";
import { fail, failFromError, ok } from "../../../lib/server/respond.js";
import { getRun, keepEvidence } from "../../../lib/server/runs.js";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const parsed = SpeakRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "bad_request", "bad speak request");
  const { runId, template, amount, token } = parsed.data;
  const run = getRun(runId);

  let text: string;
  let client;
  try {
    text = replyText(template, { amount, token });
    client = createRouterClient(routerOptions());
  } catch (e) {
    return failFromError(e, "zerog", run);
  }
  try {
    const r = await client.speak(text);
    await keepEvidence(run, r.evidence);
    return ok({
      text,
      mime: r.mime,
      audioBase64: Buffer.from(r.audio).toString("base64"),
      requestId: r.requestId,
      evidence: run.evidence,
    });
  } catch (e) {
    return failFromError(e, "zerog", run);
  }
}
