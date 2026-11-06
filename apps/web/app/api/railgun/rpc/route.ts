import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const MAX_BODY = 5 * 1024 * 1024;
const METHODS = new Set([
  "eth_chainId", "net_version", "eth_call", "eth_getLogs", "eth_blockNumber", "eth_getBlockByNumber",
  "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getCode",
  "eth_getStorageAt", "eth_getBalance", "eth_getTransactionCount", "eth_estimateGas",
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
  if (window && now - window.start < 60_000 && window.count >= 600) {
    return NextResponse.json({ error: "Railgun RPC proxy rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  if (!window || now - window.start >= 60_000) windows.set(ip, { start: now, count: 1 });
  else window.count += 1;

  const raw = await req.text();
  if (!raw || raw.length > MAX_BODY) return NextResponse.json({ error: "Invalid RPC request size" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Malformed JSON-RPC request" }, { status: 400 }); }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 20 || calls.some((call) => !call || typeof call !== "object" || !METHODS.has((call as { method?: string }).method ?? ""))) {
    return NextResponse.json({ error: "Unsupported JSON-RPC method or batch size" }, { status: 400 });
  }
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST", headers: { "content-type": "application/json" }, body: raw,
      cache: "no-store", signal: AbortSignal.timeout(25_000),
    });
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Sepolia RPC upstream unavailable" }, { status: 502 });
  }
}
