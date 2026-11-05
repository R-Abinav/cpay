// GET /api/evidence: recent zg_evidence rows for the public /evidence page (0G judges).
// Only: requestId, kind, model, trustMode, receiptStatus, teeVerified, rootHash, createdAt. No user data.
import { recentEvidence } from "../../../lib/server/zg-evidence.js";
import { json } from "../../../lib/server/zg.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const n = Number(new URL(req.url).searchParams.get("limit") ?? "100");
  try {
    const rows = await recentEvidence(Number.isFinite(n) ? n : 100);
    if (rows === null) return json({ stored: false, rows: [] });
    return json({ stored: true, rows });
  } catch (e) {
    console.error(`[0g] /api/evidence read failed (${(e as { code?: string }).code ?? (e as Error).name})`);
    return json({ error: "evidence_unavailable" }, 503);
  }
}
