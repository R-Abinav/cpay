import "server-only";
// Shared plumbing for the 0G proxy routes (/api/intent, /api/transcribe, /api/speak, /api/episode,
// /api/stage1/intent): router client from env, hub-ticket guard, per-ticket rate limit, safe-stop responses.
// Nothing here logs request content: no audio, transcript, text, tickets or IPs.
import { verifyTicket } from "@cpay/glasses-kit/ticket";
import {
  ZeroGNotConfigured,
  ZeroGUnavailable,
  createRouterClient,
  type Evidence,
  type RouterClient,
  type StorageOptions,
} from "@cpay/zerog";
import { persistEvidence, receiptStatus } from "./zg-evidence.js";

const env = (k: string): string => (process.env[k] ?? "").trim();
const isSet = (v: string) => v !== "" && v !== "sk-" && v !== "0x" && !v.includes("<");

/** Router client from ZG_* env. Models have NO defaults here: a missing one fails with zg_not_configured. */
export function zgClient(opts: { tokenAllowList?: readonly string[] } = {}): RouterClient {
  const missing = ["ZG_ROUTER_BASE_URL", "ZG_ROUTER_API_KEY"].filter((k) => !isSet(env(k)));
  if (missing.length) throw new ZeroGNotConfigured(missing.join(", "));
  const timeout = Number(env("ZG_TIMEOUT_MS"));
  const trust = env("ZG_TRUST_MODE") || "private";
  return createRouterClient({
    baseUrl: env("ZG_ROUTER_BASE_URL"),
    apiKey: env("ZG_ROUTER_API_KEY"),
    trustMode: trust,
    sttTrustMode: env("ZG_STT_TRUST_MODE") || trust,
    intentTrustMode: env("ZG_INTENT_TRUST_MODE") || trust,
    ttsTrustMode: env("ZG_TTS_TRUST_MODE") || "standard",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 8000,
    sttModel: env("ZG_STT_MODEL") || undefined,
    intentModel: env("ZG_INTENT_MODEL") || undefined,
    ttsModel: env("ZG_TTS_MODEL") || undefined,
    ttsVoice: env("ZG_TTS_VOICE") || undefined,
    ttsFormat: env("ZG_TTS_FORMAT") || undefined,
    verifyTee: env("ZG_VERIFY_TEE") ? env("ZG_VERIFY_TEE") !== "false" : undefined,
    tokenAllowList: opts.tokenAllowList ?? tokenAllowList(),
    onEvidence: persistEvidence,
  });
}

/** Tokens the intent model may name. AGENT_ALLOWED_TOKENS (default USDC). */
export function tokenAllowList(): string[] {
  return (env("AGENT_ALLOWED_TOKENS") || "USDC")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z][A-Z0-9]{1,9}$/.test(t));
}

export function zgStorageOptions(): StorageOptions {
  const missing = ["ZG_STORAGE_RPC_URL", "ZG_STORAGE_INDEXER_URL", "ZG_STORAGE_PRIVATE_KEY"].filter((k) => !isSet(env(k)));
  if (missing.length) throw new ZeroGNotConfigured(missing.join(", "));
  if (!/^0x[0-9a-fA-F]{64}$/.test(env("ZG_STORAGE_PRIVATE_KEY"))) throw new ZeroGNotConfigured("ZG_STORAGE_PRIVATE_KEY (0x + 32-byte hex)");
  return {
    rpcUrl: env("ZG_STORAGE_RPC_URL"),
    indexerUrl: env("ZG_STORAGE_INDEXER_URL"),
    privateKey: env("ZG_STORAGE_PRIVATE_KEY"),
    onEvidence: persistEvidence,
  };
}

// ---- responses -------------------------------------------------------------------------------------------

const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** What the phone gets for each 0G call: IDs + receipt only. */
export interface PublicEvidence {
  kind: string;
  model: string;
  trustMode: string;
  requestId: string | null;
  clientRequestId: string | null;
  httpStatus: number | null;
  receiptStatus: string;
  teeVerified: boolean | null;
  resKey: string | null;
  provider: string | null;
  /** `x-0g-e2ee` response header ("sealed" = private-mode end-to-end encrypted to the TEE provider) */
  e2ee: string | null;
  latencyMs: number | null;
  error?: string;
  refusal?: string;
  rootHash?: string;
  txHash?: string;
}

export function publicEvidence(ev: Evidence): PublicEvidence {
  const out: PublicEvidence = {
    kind: ev.kind,
    model: ev.model,
    trustMode: String(ev.trustMode),
    requestId: ev.requestId,
    clientRequestId: ev.clientRequestId,
    httpStatus: ev.httpStatus,
    receiptStatus: receiptStatus(ev),
    teeVerified: ev.receipt?.teeVerified ?? null,
    resKey: ev.receipt?.resKey ?? null,
    provider: ev.receipt?.provider ?? null,
    e2ee: ev.rawZgHeaders["x-0g-e2ee"] ?? null,
    latencyMs: ev.latencyMs,
  };
  if (ev.error) out.error = ev.error;
  if (ev.refusal) out.refusal = ev.refusal;
  if (ev.rootHash) out.rootHash = ev.rootHash;
  if (ev.txHash) out.txHash = ev.txHash;
  return out;
}

/**
 * Safe-stop. Never a fallback answer. 503 + `zg_unavailable` (UI: BRAIN OFFLINE) with the real request ID
 * when 0G answered; `zg_not_configured` when env is missing. `prior` = evidence of earlier calls in this request.
 */
export function zgFailure(e: unknown, prior: readonly Evidence[] = []): Response {
  if (e instanceof ZeroGNotConfigured) {
    console.error(`[0g] not configured: ${e.missing}`);
    return json({ error: "zg_not_configured", missing: e.missing }, 503);
  }
  if (e instanceof ZeroGUnavailable) {
    const evidence = [...prior, ...(e.evidence ? [e.evidence] : [])].map(publicEvidence);
    return json({ error: "zg_unavailable", requestId: e.evidence?.requestId ?? undefined, evidence }, 503);
  }
  console.error(`[0g] unexpected failure (${(e as Error)?.name ?? "unknown"}): safe-stop`);
  return json({ error: "zg_unavailable", evidence: prior.map(publicEvidence) }, 503);
}

// ---- hub ticket + rate limit -----------------------------------------------------------------------------

const g = globalThis as typeof globalThis & { __cpayZgRate?: Map<string, { start: number; n: number }> };
const buckets = (g.__cpayZgRate ??= new Map());

/** Test hook. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}

function rateLimited(key: string, now = Date.now()): boolean {
  const limit = Number(env("ZG_RATE_LIMIT_PER_MIN")) > 0 ? Number(env("ZG_RATE_LIMIT_PER_MIN")) : 20;
  for (const [k, b] of buckets) if (now - b.start >= 60_000) buckets.delete(k);
  const b = buckets.get(key);
  if (!b) {
    buckets.set(key, { start: now, n: 1 });
    return false;
  }
  b.n += 1;
  return b.n > limit;
}

/**
 * Requires a valid hub ticket (`x-cpay-ticket`, from cpay-hub) before spending 0G credits.
 * Without a ticket: refused in production; allowed in dev (Stage 1 page) with a warning line.
 * Returns null when the request may proceed, else the error Response.
 */
export function guardZg(req: Request, route: string): Response | null {
  const token = req.headers.get("x-cpay-ticket");
  let key: string;
  if (!token) {
    if (process.env.NODE_ENV === "production") return json({ error: "ticket_required" }, 401);
    console.warn(`[0g] WARN ${route}: no hub ticket, allowed because NODE_ENV=${process.env.NODE_ENV ?? "unset"} (dev only)`);
    key = "dev-no-ticket";
  } else {
    const secret = env("HUB_TICKET_SECRET");
    if (secret.length < 32) {
      console.error(`[0g] ${route}: HUB_TICKET_SECRET missing or too short; refusing ticketed request`);
      return json({ error: "ticket_not_configured" }, 503);
    }
    const claims = verifyTicket(token, secret);
    if (!claims) return json({ error: "ticket_invalid" }, 401);
    key = `t:${claims.id}`;
  }
  if (rateLimited(key)) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  return null;
}

// ---- audio input -----------------------------------------------------------------------------------------

export const MAX_AUDIO_BYTES = 1024 * 1024;
const AUDIO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
};

export type AudioInput = { ok: true; bytes: Uint8Array; filename: string } | { ok: false; res: Response };

/** Audio from multipart (`audio` field) or a raw `audio/*` / octet-stream body. Max 1 MiB. */
export async function readAudio(req: Request): Promise<AudioInput> {
  const tooLarge = (): AudioInput => ({ ok: false, res: json({ error: "audio_too_large", maxBytes: MAX_AUDIO_BYTES }, 413) });
  const bad = (): AudioInput => ({ ok: false, res: json({ error: "bad_request", detail: "expected audio" }, 400) });
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_AUDIO_BYTES + 16 * 1024) return tooLarge();
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  let blob: Blob;
  try {
    if (ct.startsWith("multipart/form-data")) {
      const f = (await req.formData()).get("audio");
      if (!(f instanceof Blob)) return bad();
      blob = f;
    } else if (ct.startsWith("audio/") || ct.startsWith("application/octet-stream")) {
      blob = new Blob([await req.arrayBuffer()], { type: ct.split(";")[0] });
    } else return bad();
  } catch {
    return bad();
  }
  if (blob.size === 0) return bad();
  if (blob.size > MAX_AUDIO_BYTES) return tooLarge();
  const mime = (blob.type || "audio/webm").split(";")[0]!.trim();
  return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()), filename: `audio.${AUDIO_EXT[mime] ?? "webm"}` };
}
