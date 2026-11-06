// ERC-4337 bundler proxy (POST /api/bundler). The phone's Railgun client (@cpay/railgun) sends its
// UserOperation JSON-RPC here; we forward it to Pimlico with OUR key (PIMLICO_API_KEY, server env
// only, never sent to the browser). Pass-through only (invariant 4): nothing is stored and nothing is
// logged: no bodies, no IPs, no user agents, no UserOperation hashes. Only the methods Kohaku's
// Pimlico bundler calls are allowed (read from the alpha.31 WASM and observed in a live Sepolia payment).
// The rate limit is one global bucket, so no per-client identifier is ever kept. Only our own web origin
// may call it (Origin allow-list), so the sponsored key isn't an open bundler for other sites.
import { z } from "zod";

export const BUNDLER_METHODS = [
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "pimlico_getUserOperationGasPrice",
] as const;

export const MAX_BODY_BYTES = 128 * 1024;
const MAX_BATCH = 10;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 600;

const Call = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string().max(64), z.null()]),
    method: z.enum(BUNDLER_METHODS),
    params: z.array(z.unknown()).max(4).optional(),
  })
  .strict();
const Body = z.union([Call, z.array(Call).min(1).max(MAX_BATCH)]);

const PIMLICO_CHAIN: Record<number, string> = { 11155111: "sepolia", 1: "ethereum" };

const g = globalThis as typeof globalThis & { __cpayBundlerRate?: { start: number; n: number } };

export function __resetBundlerRateForTests(): void {
  g.__cpayBundlerRate = undefined;
}

function rateOk(now = Date.now()): boolean {
  const b = g.__cpayBundlerRate;
  if (!b || now - b.start >= RATE_WINDOW_MS) {
    g.__cpayBundlerRate = { start: now, n: 1 };
    return true;
  }
  b.n += 1;
  return b.n <= RATE_MAX;
}

function rpcError(status: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32600, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export interface BundlerEnv {
  apiKey: string | undefined;
  chainId: number;
  /** exact origins (scheme://host[:port]) allowed to call; empty = refuse every request */
  allowedOrigins: readonly string[];
  fetch?: typeof fetch;
}

export async function handleBundler(req: Request, env: BundlerEnv): Promise<Response> {
  if (!env.apiKey) return rpcError(503, "bundler not configured");
  const chain = PIMLICO_CHAIN[env.chainId];
  if (!chain) return rpcError(503, "bundler chain not supported");
  const origin = req.headers.get("origin");
  if (!origin || !env.allowedOrigins.includes(origin)) return rpcError(403, "origin not allowed");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return rpcError(415, "content-type must be application/json");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return rpcError(413, "body too large");
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return rpcError(413, "body too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, "invalid JSON");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return rpcError(400, "method not allowed or malformed request");
  if (!rateOk()) return rpcError(429, "rate limited");

  const upstream = `https://api.pimlico.io/v2/${chain}/rpc?apikey=${encodeURIComponent(env.apiKey)}`;
  let res: Response;
  try {
    res = await (env.fetch ?? fetch)(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch {
    // Never echo the upstream error: it can contain the URL (and so the key).
    return rpcError(502, "bundler unreachable");
  }
  const out = await res.text();
  return new Response(out, {
    status: res.status,
    headers: { "content-type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Origins allowed to call the proxy: BUNDLER_ALLOWED_ORIGINS (comma-separated) if set, else the web app's
 * own origin https://<NEXT_PUBLIC_PASSKEY_RP_ID> (passkeys are bound to that domain), plus
 * http://localhost:3000 outside production.
 */
export function bundlerOrigins(env: Record<string, string | undefined>): string[] {
  const list = (env.BUNDLER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (list.length > 0) return list;
  const out: string[] = [];
  const rp = env.NEXT_PUBLIC_PASSKEY_RP_ID?.trim();
  if (rp && /^[a-z0-9.-]+$/i.test(rp) && rp !== "localhost") out.push(`https://${rp}`);
  if (env.NODE_ENV !== "production") out.push("http://localhost:3000");
  return out;
}
