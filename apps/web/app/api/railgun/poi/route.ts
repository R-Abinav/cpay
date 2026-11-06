import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = "https://poi-sepolia.railgun.org";
const MAX_BODY = 8 * 1024 * 1024;
const METHODS = new Set([
  "ppoi_health", "ppoi_node_status", "ppoi_node_status_forwardedList", "ppoi_poi_events",
  "ppoi_poi_merkletree_leaves", "ppoi_transact_proofs", "ppoi_legacy_transact_proofs",
  "ppoi_blocked_shields", "ppoi_submit_poi_events", "ppoi_submit_validated_txid",
  "ppoi_remove_transact_proof", "ppoi_submit_transact_proof", "ppoi_submit_legacy_transact_proofs",
  "ppoi_submit_single_commitment_proofs", "ppoi_pois_per_list", "ppoi_pois_per_blinded_commitment",
  "ppoi_merkle_proofs", "ppoi_validated_txid", "ppoi_validate_txid_merkleroot", "ppoi_validate_poi_merkleroots",
]);
const windows = new Map<string, { start: number; count: number }>();

function clientIp(req: NextRequest): string | null {
  const value = req.headers.get("cf-connecting-ip")?.trim();
  return value && isIP(value) ? value : null;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (!ip) return NextResponse.json({ error: "Trusted client IP header missing" }, { status: 503 });
  const now = Date.now();
  const window = windows.get(ip);
  if (window && now - window.start < 60_000 && window.count >= 240) {
    return NextResponse.json({ error: "Railgun POI proxy rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  if (!window || now - window.start >= 60_000) windows.set(ip, { start: now, count: 1 });
  else window.count += 1;

  const raw = await req.text();
  if (!raw || raw.length > MAX_BODY) return NextResponse.json({ error: "Invalid POI request size" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Malformed POI JSON-RPC request" }, { status: 400 }); }
  if (!body || typeof body !== "object" || !METHODS.has((body as { method?: string }).method ?? "")) {
    return NextResponse.json({ error: "Unsupported POI JSON-RPC method" }, { status: 400 });
  }
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST", headers: { "content-type": "application/json" }, body: raw,
      cache: "no-store", signal: AbortSignal.timeout(58_000),
    });
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Railgun POI upstream unavailable" }, { status: 502 });
  }
}
