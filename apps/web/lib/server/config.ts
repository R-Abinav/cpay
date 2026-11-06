import "server-only";
// Server-side configuration for the agent runtime. Secrets stay here (never NEXT_PUBLIC_*).
// No user key is read here: payments are signed on the phone (invariant 1).
import { resolve } from "node:path";

const env = (k: string): string => (process.env[k] ?? "").trim();

/** Placeholders from .env.example count as unset. */
function isSet(v: string): boolean {
  return v !== "" && v !== "0x" && v !== "sk-" && v !== "app_" && v !== "rp_" && !v.includes("<");
}

export class NotConfigured extends Error {
  override name = "NotConfigured";
  constructor(readonly missing: string[]) {
    super(`not configured: ${missing.join(", ")}`);
  }
}

function require_(keys: string[]): Record<string, string> {
  const missing = keys.filter((k) => !isSet(env(k)));
  if (missing.length) throw new NotConfigured(missing);
  return Object.fromEntries(keys.map((k) => [k, env(k)]));
}

/** Relative data paths in .env (./data/...) resolve against the repo root, where .env lives. */
const dataPath = (p: string) => resolve(process.env.CPAY_REPO_ROOT || resolve(process.cwd(), "../.."), p);

export function zgEvidencePath(): string {
  return dataPath(env("ZG_EVIDENCE_PATH") || "./data/zerog-evidence.jsonl");
}

export function routerOptions() {
  const r = require_(["ZG_ROUTER_BASE_URL", "ZG_ROUTER_API_KEY"]);
  const n = Number(env("ZG_TIMEOUT_MS"));
  return {
    baseUrl: r.ZG_ROUTER_BASE_URL!,
    apiKey: r.ZG_ROUTER_API_KEY!,
    trustMode: env("ZG_TRUST_MODE") || "private",
    timeoutMs: Number.isFinite(n) && n > 0 ? n : 8000,
    sttModel: env("ZG_STT_MODEL") || undefined,
    intentModel: env("ZG_INTENT_MODEL") || undefined,
    ttsModel: env("ZG_TTS_MODEL") || undefined,
    ttsVoice: env("ZG_TTS_VOICE") || undefined,
    ttsTrustMode: env("ZG_TTS_TRUST_MODE") || undefined,
  };
}

export function storageOptions() {
  const r = require_(["ZG_STORAGE_RPC_URL", "ZG_STORAGE_INDEXER_URL", "ZG_STORAGE_PRIVATE_KEY", "ZG_EPISODE_KEY"]);
  const key = r.ZG_EPISODE_KEY!.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new NotConfigured(["ZG_EPISODE_KEY (32-byte hex)"]);
  return {
    opts: {
      rpcUrl: r.ZG_STORAGE_RPC_URL!,
      indexerUrl: r.ZG_STORAGE_INDEXER_URL!,
      privateKey: r.ZG_STORAGE_PRIVATE_KEY!,
      evidencePath: zgEvidencePath(),
    },
    episodeKey: Uint8Array.from(key.match(/../g)!.map((h) => parseInt(h, 16))),
  };
}

export function agentPassConfig() {
  const r = require_(["AGENT_PASS_ISSUER", "AGENT_PASS_CLIENT_ID", "AGENT_PASS_CLIENT_SECRET", "AGENT_PASS_REDIRECT_URI", "AGENT_PASS_ACR"]);
  const ttl = Number(env("AGENT_APPROVAL_TTL_SECONDS"));
  return {
    issuer: r.AGENT_PASS_ISSUER!,
    clientId: r.AGENT_PASS_CLIENT_ID!,
    clientSecret: r.AGENT_PASS_CLIENT_SECRET!,
    redirectUri: r.AGENT_PASS_REDIRECT_URI!,
    acr: r.AGENT_PASS_ACR!,
    approvalTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 300,
  };
}

export function chainConfig() {
  const r = require_(["SEPOLIA_RPC_URL"]);
  const chainId = Number(env("NEXT_PUBLIC_CHAIN_ID") || "11155111");
  const gas = env("GAS_DROP_WEI");
  return {
    rpcUrl: r.SEPOLIA_RPC_URL!,
    rpcHost: safeHost(r.SEPOLIA_RPC_URL!),
    chainId,
    usdcAddress: env("NEXT_PUBLIC_USDC_ADDRESS") || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    gasDropWei: /^\d+$/.test(gas) ? BigInt(gas) : 300_000_000_000_000n,
  };
}

/** Host only (no path/query), so an RPC key in the URL never reaches the UI. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export function policyEnv() {
  return {
    paymentCapUsdc: env("AGENT_PAYMENT_CAP_USDC") || "5",
    dailyCapUsdc: env("AGENT_DAILY_CAP_USDC") || "15",
    allowedTokens: (env("AGENT_ALLOWED_TOKENS") || "USDC").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean),
  };
}

/** Issuer's BBS public key: pinned in env if set, else fetched from the issuer. */
export async function issuerPublicKey(): Promise<string> {
  const pinned = env("ISSUER_BBS_PUBLIC_KEY");
  if (isSet(pinned)) return pinned;
  const url = (env("ISSUER_URL") || env("NEXT_PUBLIC_ISSUER_URL")).replace(/\/$/, "");
  if (!isSet(url)) throw new NotConfigured(["ISSUER_BBS_PUBLIC_KEY or NEXT_PUBLIC_ISSUER_URL"]);
  const res = await fetch(`${url}/issuer-key`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`issuer /issuer-key -> ${res.status}`);
  const body = (await res.json()) as { publicKey?: unknown };
  if (typeof body.publicKey !== "string" || body.publicKey.length === 0) throw new Error("issuer /issuer-key: no publicKey");
  return body.publicKey;
}
