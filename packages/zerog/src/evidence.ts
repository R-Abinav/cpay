// 0G evidence: one record per 0G call (docs/STACK.md "0G evidence").
// IDs, receipts, model names and hashes only. NEVER transcript text, intent text, audio, faces or addresses.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type TrustMode = "private" | "verified" | "standard" | (string & {});
export type EvidenceKind = "transcribe" | "intent" | "speak" | "storage";

/**
 * What 0G gives us as a per-response receipt, built ONLY from documented fields:
 *
 * - `resKey`: the `ZG-Res-Key` response header, "the PROVIDER's response id, passed through verbatim
 *   ... it lets a client independently verify the provider's TEE signature for that specific response
 *   against the provider's signature endpoint" (router OpenAPI changelog). The signature itself is
 *   fetched from `<provider broker>/v1/proxy/signature/{resKey}` (0g-pc-e2ee protocol/SPEC.md §8);
 *   see `fetchResponseSignature`.
 * - `teeVerified`: `x_0g_trace.tee_verified`, the router's verdict on that provider signature
 *   (true = obtained and verified, false = bad/unobtainable, null = absent: not asked, standard mode,
 *   or an E2EE request) (router OpenAPI, TraceInfo.tee_verified). We ask for it with `verify_tee: true`.
 * - `provider` / `providerIdentity`: `x_0g_trace.provider` / `.provider_identity` (who signed).
 *
 * Until the 0G booth confirms which of these they call "the receipt", the raw trace and headers are
 * kept verbatim in `rawTrace` / `rawZgHeaders` as well.
 */
export interface ZgReceipt {
  resKey: string | null;
  teeVerified: boolean | null;
  provider: string | null;
  providerIdentity: string | null;
}

/** One record per 0G call. Shape from docs/STACK.md "0G evidence", plus the documented extras below. */
export interface Evidence {
  ts: string;
  kind: EvidenceKind;
  model: string;
  trustMode: TrustMode;
  httpStatus: number | null;
  /** `X-Request-ID` header, falling back to `x_0g_trace.request_id` (or an error body's `request_id`). */
  requestId: string | null;
  /** Our own `X-Client-Request-Id` (router-documented lookup key, kept 30 days by 0G support). Lets us
   * trace a request even when it timed out before we saw its `X-Request-ID`. */
  clientRequestId: string | null;
  /** See ZgReceipt. null when 0G sent none of the receipt fields. */
  receipt: ZgReceipt | null;
  /** verbatim `x_0g_trace` body object (null for binary responses such as TTS audio) */
  rawTrace: unknown | null;
  /** verbatim 0G response headers: every `x-0g-*` and `zg-*` header plus `x-request-id`,
   * `x-provider` and `x-client-request-id`. Names are lower-cased by fetch; values are verbatim. */
  rawZgHeaders: Record<string, string>;
  latencyMs: number | null;
  /** failure only: a machine code (`timeout`, `network`, `http_503`, the router's `error.code`, ...).
   * Never an error message, which could echo request content. */
  error?: string;
  /** intent only: the fixed refusal code when the model's output was refused. Never model text. */
  refusal?: string;
  /** storage only */
  rootHash?: string;
  txHash?: string;
  /** storage only: the plaintext index rootHash -> request IDs, so judges can match calls to episodes */
  requestIds?: string[];
}

const EXTRA_HEADERS = new Set(["x-request-id", "x-provider", "x-client-request-id"]);

/** Every `x-0g-*` / `zg-*` header plus x-request-id, x-provider, x-client-request-id, values verbatim. */
export function pickZgHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n.startsWith("x-0g-") || n.startsWith("zg-") || EXTRA_HEADERS.has(n)) out[n] = value;
  });
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The verbatim `x_0g_trace` object from a JSON body, or null. */
export function extractTrace(body: unknown): unknown | null {
  return isRecord(body) && "x_0g_trace" in body ? (body.x_0g_trace ?? null) : null;
}

/**
 * Request ID: the `X-Request-ID` header, falling back to `x_0g_trace.request_id`, then the
 * top-level `request_id` of a router error body (ErrorResponse). null if none (a failure for callers).
 */
export function extractRequestId(headers: Headers, body: unknown): string | null {
  const h = headers.get("x-request-id");
  if (h && h.trim()) return h.trim();
  const trace = extractTrace(body);
  if (isRecord(trace) && typeof trace.request_id === "string" && trace.request_id) return trace.request_id;
  if (isRecord(body) && typeof body.request_id === "string" && body.request_id) return body.request_id;
  return null;
}

/** Receipt fields from the documented header + trace fields. null when none is present. */
export function extractReceipt(headers: Headers, body: unknown): ZgReceipt | null {
  const trace = extractTrace(body);
  const t = isRecord(trace) ? trace : {};
  const receipt: ZgReceipt = {
    resKey: headers.get("zg-res-key") || null,
    teeVerified: typeof t.tee_verified === "boolean" ? t.tee_verified : null,
    provider: typeof t.provider === "string" && t.provider ? t.provider : null,
    providerIdentity: typeof t.provider_identity === "string" && t.provider_identity ? t.provider_identity : null,
  };
  const empty =
    receipt.resKey === null &&
    receipt.teeVerified === null &&
    receipt.provider === null &&
    receipt.providerIdentity === null;
  return empty ? null : receipt;
}

/** The single console line for one record. Contains IDs only. */
export function formatEvidenceLine(ev: Evidence): string {
  const parts = [`[0g] kind=${ev.kind}`, `model=${ev.model}`];
  if (ev.kind === "storage") {
    parts.push(`rootHash=${ev.rootHash ?? "missing"}`, `txHash=${ev.txHash ?? "missing"}`);
    parts.push(`requestIds=${(ev.requestIds ?? []).join(",") || "none"}`);
  } else {
    parts.push(`trust=${ev.trustMode}`, `status=${ev.httpStatus ?? "none"}`);
    parts.push(`requestId=${ev.requestId ?? "missing"}`);
    parts.push(`receipt=${ev.receipt?.resKey ?? "missing"}`);
    const tv = ev.receipt?.teeVerified;
    parts.push(`tee_verified=${tv === true ? "true" : tv === false ? "false" : "absent"}`);
    if (ev.receipt?.provider) parts.push(`provider=${ev.receipt.provider}`);
    parts.push(`clientRequestId=${ev.clientRequestId ?? "none"}`);
  }
  if (ev.refusal) parts.push(`refusal=${ev.refusal}`);
  if (ev.error) parts.push(`error=${ev.error}`);
  return parts.join(" ");
}

/**
 * Prints `[0g] kind=… model=… requestId=… receipt=…|missing` and appends the record to the JSONL at
 * `evidencePath` (parent dirs created). A failed append is reported loudly on stderr but does not
 * throw: evidence I/O must not turn a completed 0G call into a failure.
 */
export async function recordEvidence(evidence: Evidence, evidencePath?: string): Promise<void> {
  console.log(formatEvidenceLine(evidence));
  if (!evidencePath) return;
  try {
    await mkdir(dirname(evidencePath), { recursive: true });
    await appendFile(evidencePath, JSON.stringify(evidence) + "\n", "utf8");
  } catch (err) {
    console.error(`[0g] evidence append FAILED path=${evidencePath} code=${(err as NodeJS.ErrnoException).code ?? "unknown"}`);
  }
}
