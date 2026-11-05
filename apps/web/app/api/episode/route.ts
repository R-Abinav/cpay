// POST /api/episode: the phone's ENCRYPTED episode envelope (encryptEpisode from @cpay/zerog/browser, keyed
// on the phone) -> 0G Storage -> rootHash. The server never sees plaintext or the episode key; anything
// that is not exactly an envelope is refused. Upload gas is paid with our 0G Storage key.
import { ZeroGUnavailable, parseEpisodeEnvelope, uploadEpisode } from "@cpay/zerog";
import { z } from "zod";
import { guardZg, json, publicEvidence, zgFailure, zgStorageOptions } from "../../../lib/server/zg.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CIPHERTEXT_B64 = 96 * 1024;
const Body = z
  .object({
    /** base64 of the envelope bytes returned by encryptEpisode() */
    ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_B64).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    /** 0G request IDs referenced by the episode (plaintext index in evidence) */
    requestIds: z.array(z.string().regex(/^[\w.:-]{1,128}$/)).max(32).default([]),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const denied = guardZg(req, "/api/episode");
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", detail: "expected {ciphertext: base64, requestIds: string[]}" }, 400);
  const bytes = new Uint8Array(Buffer.from(parsed.data.ciphertext, "base64"));
  if (!parseEpisodeEnvelope(bytes)) return json({ error: "not_ciphertext", detail: "body is not an encrypted episode envelope" }, 400);

  try {
    const r = await uploadEpisode(bytes, parsed.data.requestIds, zgStorageOptions());
    return json({ rootHash: r.rootHash, txHash: r.txHash, evidence: [publicEvidence(r.evidence)] });
  } catch (e) {
    if (e instanceof ZeroGUnavailable) return json({ error: "zg_storage_unavailable", evidence: e.evidence ? [publicEvidence(e.evidence)] : [] }, 503);
    return zgFailure(e);
  }
}
