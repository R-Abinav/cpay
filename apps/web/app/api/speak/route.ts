// POST /api/speak: template key + validated values -> fixed replyText() -> 0G TTS -> audio for the earbuds.
// Never free text: the body admits only a template key, a decimal amount, a token symbol and a numeric code.
import { REPLY_TEMPLATES, replyText, type ReplyTemplate } from "@cpay/zerog";
import { z } from "zod";
import { guardZg, json, publicEvidence, zgClient, zgFailure } from "../../../lib/server/zg.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  template: z.enum(REPLY_TEMPLATES as [ReplyTemplate, ...ReplyTemplate[]]),
  amount: z.string().max(20).optional(),
  token: z.string().max(10).optional(),
  code: z.string().max(4).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const denied = guardZg(req, "/api/speak");
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", detail: "unknown template" }, 400);
  const { template, amount, token, code } = parsed.data;

  let text: string;
  try {
    text = replyText(template, { amount, token, code });
  } catch {
    return json({ error: "bad_request", detail: "invalid or missing template value" }, 400);
  }
  try {
    const r = await zgClient().speak(text);
    return json({
      template,
      text,
      mime: r.mime,
      audioBase64: Buffer.from(r.audio).toString("base64"),
      requestId: r.requestId,
      evidence: [publicEvidence(r.evidence)],
    });
  } catch (e) {
    return zgFailure(e);
  }
}
