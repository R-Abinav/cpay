// 0G router client: ears (whisper-large-v3), brain (intent model), voice (TTS of fixed templates).
// Plain fetch. Every failure is a safe-stop (ZeroGUnavailable): no fallback model, no regex parser,
// no cached answer. Every call, failed or not, produces one evidence record.

import { randomUUID } from "node:crypto";
import {
  extractReceipt,
  extractRequestId,
  extractTrace,
  pickZgHeaders,
  recordEvidence,
  type Evidence,
  type EvidenceKind,
  type TrustMode,
} from "./evidence.js";
import { DEFAULT_TOKEN_ALLOW_LIST, intentSystemPrompt, validateIntentOutput, type Intent, type RefusalReason } from "./intent.js";
import { isTemplateText } from "./reply.js";

/** A required model/config value is unset. Thrown before any network call (no evidence: 0G was not asked). */
export class ZeroGNotConfigured extends Error {
  override name = "ZeroGNotConfigured";
  constructor(readonly missing: string) {
    super(`${missing} is not set`);
  }
}

/** Thrown on network error, non-2xx, timeout, malformed 2xx or a missing request ID.
 * The UI and OLED show BRAIN OFFLINE - PAUSED. `evidence` is always set. */
export class ZeroGUnavailable extends Error {
  override name = "ZeroGUnavailable";
  constructor(
    message: string,
    readonly evidence?: Evidence,
  ) {
    super(message);
  }
}

export interface RouterClientOptions {
  /** e.g. https://router-api.0g.ai/v1 */
  baseUrl: string;
  apiKey: string;
  /** `X-0G-Provider-Trust-Mode` for transcribe + intent unless overridden per kind. "private" for the demo. */
  trustMode: TrustMode;
  /** trust mode for transcribe only; defaults to `trustMode` */
  sttTrustMode?: TrustMode;
  /** safe-stop after this many ms (per call) */
  timeoutMs: number;
  /** ZG_STT_MODEL. No default: the teammate chooses. transcribe() throws before any network call if unset. */
  sttModel?: string;
  /** ZG_INTENT_MODEL. No default (check it has a provider at `intentTrustMode`). parseIntent() throws if unset. */
  intentModel?: string;
  /** trust mode for intent only; defaults to `trustMode` */
  intentTrustMode?: TrustMode;
  /** ZG_TTS_MODEL. No default. speak() throws if unset. */
  ttsModel?: string;
  /** a voice id from GET /v1/models -> speech_capabilities.voices */
  ttsVoice?: string;
  /** Sent as X-0G-Provider-Trust-Mode on TTS only when "verified" or "private". TTS providers are
   * currently `standard`, and the header is a floor, so leave it unset/"standard". */
  ttsTrustMode?: TrustMode;
  /** default "mp3" */
  ttsFormat?: string;
  /** default ["USDC"] */
  tokenAllowList?: readonly string[];
  /** default "lite"; the model never chooses the mode */
  mode?: "lite" | "full";
  /** Ask the router to verify the provider's per-response TEE signature (`verify_tee: true`, reported
   * back as `x_0g_trace.tee_verified`). Default true. Not sent to TTS (extra fields are a 400 there). */
  verifyTee?: boolean;
  /** Append every evidence record here (JSONL). The console line is printed either way. Ignored when
   * `onEvidence` is set. */
  evidencePath?: string;
  /** Evidence sink. When set, it replaces the default (console line + JSONL) and is awaited for every
   * record, failed calls included. It must log its own single line. A throwing sink is reported on
   * stderr and never turns a completed 0G call into a failure. */
  onEvidence?: (evidence: Evidence) => void | Promise<void>;
  /** Debug hook (smoke script): every raw response's status, ALL headers and the verbatim trace. */
  onRawResponse?: (info: RawResponseInfo) => void;
}

export interface RawResponseInfo {
  kind: EvidenceKind;
  status: number;
  headers: Record<string, string>;
  trace: unknown | null;
}

export type IntentResult =
  | { refused: false; intent: Intent; requestId: string; evidence: Evidence }
  | { refused: true; reason: RefusalReason; requestId: string; evidence: Evidence };

export interface TranscribeOptions {
  /** helps the provider detect the format; default "audio.webm" (browser MediaRecorder) */
  filename?: string;
  /** ISO-639-1, default "en" */
  language?: string;
}

export interface RouterClient {
  transcribe(audio: Blob | Uint8Array, opts?: TranscribeOptions): Promise<{ text: string; requestId: string; evidence: Evidence }>;
  parseIntent(text: string): Promise<IntentResult>;
  /** `text` must come from replyText(); anything else throws before any network call. */
  speak(text: string): Promise<{ audio: ArrayBuffer; mime: string; requestId: string; evidence: Evidence }>;
}

interface CallSpec {
  kind: EvidenceKind;
  model: string;
  trustMode: TrustMode;
  path: string;
  /** JSON body, or a FormData (multipart) body. Private STT providers refuse JSON audio (they only accept
   * JSON as an E2EE envelope), so transcribe uploads the file as multipart. */
  body: unknown;
  /** whether to send X-0G-Provider-Trust-Mode */
  sendTrustHeader: boolean;
  /** "json" responses carry x_0g_trace; "audio" is binary */
  expect: "json" | "audio";
}

interface CallOk {
  status: number;
  headers: Headers;
  json: unknown;
  audio: ArrayBuffer | null;
  mime: string;
  requestId: string;
  evidence: Evidence;
}

function errorCode(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "object" && e !== null) {
      const code = (e as { code?: unknown }).code ?? (e as { type?: unknown }).type;
      if (typeof code === "string" && /^[\w.-]{1,64}$/.test(code)) return `http_${status}:${code}`;
    }
  }
  return `http_${status}`;
}

export function createRouterClient(opts: RouterClientOptions): RouterClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const sttTrustMode = opts.sttTrustMode ?? opts.trustMode;
  const intentTrustMode = opts.intentTrustMode ?? opts.trustMode;
  const ttsFormat = opts.ttsFormat ?? "mp3";
  const allowList = opts.tokenAllowList ?? DEFAULT_TOKEN_ALLOW_LIST;
  const mode = opts.mode ?? "lite";
  const verifyTee = opts.verifyTee ?? true;
  if (!opts.apiKey) throw new Error("createRouterClient: apiKey is required (ZG_ROUTER_API_KEY)");

  /** Model ids come from config only; a missing one stops before any network call. */
  const model = (v: string | undefined, envName: string): string => {
    if (!v || !v.trim()) throw new ZeroGNotConfigured(envName);
    return v.trim();
  };

  async function emit(ev: Evidence): Promise<void> {
    if (!opts.onEvidence) return recordEvidence(ev, opts.evidencePath);
    try {
      await opts.onEvidence(ev);
    } catch {
      console.error(`[0g] evidence sink FAILED kind=${ev.kind} requestId=${ev.requestId ?? "missing"}`);
    }
  }

  async function call(spec: CallSpec): Promise<CallOk> {
    const clientRequestId = randomUUID();
    const started = Date.now();
    const base = (): Evidence => ({
      ts: new Date().toISOString(),
      kind: spec.kind,
      model: spec.model,
      trustMode: spec.trustMode,
      httpStatus: null,
      requestId: null,
      clientRequestId,
      receipt: null,
      rawTrace: null,
      rawZgHeaders: {},
      latencyMs: Date.now() - started,
    });
    const fail = async (message: string, ev: Evidence): Promise<never> => {
      await emit(ev);
      throw new ZeroGUnavailable(message, ev);
    };

    const multipart = spec.body instanceof FormData;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      "X-Client-Request-Id": clientRequestId,
    };
    // fetch sets the multipart boundary itself.
    if (!multipart) headers["Content-Type"] = "application/json";
    if (spec.sendTrustHeader) headers["X-0G-Provider-Trust-Mode"] = spec.trustMode;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    let res: Response;
    let raw: ArrayBuffer;
    try {
      res = await fetch(`${baseUrl}${spec.path}`, {
        method: "POST",
        headers,
        body: multipart ? (spec.body as FormData) : JSON.stringify(spec.body),
        signal: ac.signal,
      });
      raw = await res.arrayBuffer();
    } catch {
      clearTimeout(timer);
      const timedOut = ac.signal.aborted;
      return fail(`0G ${spec.kind}: ${timedOut ? `timeout after ${opts.timeoutMs} ms` : "network error"}`, {
        ...base(),
        error: timedOut ? "timeout" : "network",
      });
    }
    clearTimeout(timer);

    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    let json: unknown = null;
    if (mime === "application/json" || mime.endsWith("+json")) {
      try {
        json = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        json = null;
      }
    }
    const trace = extractTrace(json);
    opts.onRawResponse?.({
      kind: spec.kind,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      trace,
    });

    const requestId = extractRequestId(res.headers, json);
    const evidence: Evidence = {
      ...base(),
      httpStatus: res.status,
      requestId,
      receipt: extractReceipt(res.headers, json),
      rawTrace: trace,
      rawZgHeaders: pickZgHeaders(res.headers),
    };

    if (!res.ok) return fail(`0G ${spec.kind}: HTTP ${res.status}`, { ...evidence, error: errorCode(json, res.status) });
    if (!requestId) return fail(`0G ${spec.kind}: response has no request ID`, { ...evidence, error: "missing_request_id" });
    if (spec.expect === "json" && json === null) return fail(`0G ${spec.kind}: non-JSON 2xx`, { ...evidence, error: "malformed_response" });
    if (spec.expect === "audio" && (json !== null || raw.byteLength === 0))
      return fail(`0G ${spec.kind}: 2xx without audio`, { ...evidence, error: "malformed_response" });

    return { status: res.status, headers: res.headers, json, audio: spec.expect === "audio" ? raw : null, mime, requestId, evidence };
  }

  return {
    async transcribe(audio, topts) {
      const sttModel = model(opts.sttModel, "ZG_STT_MODEL");
      const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(await audio.arrayBuffer());
      const r = await call({
        kind: "transcribe",
        model: sttModel,
        trustMode: sttTrustMode,
        path: "/audio/transcriptions",
        sendTrustHeader: true,
        expect: "json",
        body: (() => {
          const form = new FormData();
          form.append("model", sttModel);
          form.append("file", new Blob([new Uint8Array(bytes)]), topts?.filename ?? "audio.webm");
          form.append("language", topts?.language ?? "en");
          form.append("response_format", "json");
          if (verifyTee) form.append("verify_tee", "true");
          return form;
        })(),
      });
      const text = (r.json as { text?: unknown }).text;
      if (typeof text !== "string") {
        const ev = { ...r.evidence, error: "malformed_response" };
        await emit(ev);
        throw new ZeroGUnavailable("0G transcribe: response has no text", ev);
      }
      await emit(r.evidence);
      return { text, requestId: r.requestId, evidence: r.evidence };
    },

    async parseIntent(text) {
      const intentModel = model(opts.intentModel, "ZG_INTENT_MODEL");
      const r = await call({
        kind: "intent",
        model: intentModel,
        trustMode: intentTrustMode,
        path: "/chat/completions",
        sendTrustHeader: true,
        expect: "json",
        body: {
          model: intentModel,
          messages: [
            { role: "system", content: intentSystemPrompt(allowList) },
            { role: "user", content: text },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 1024,
          stream: false,
          ...(verifyTee ? { verify_tee: true } : {}),
        },
      });
      const choices = (r.json as { choices?: unknown }).choices;
      const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
      if (!first || typeof first.message !== "object") {
        const ev = { ...r.evidence, error: "malformed_response" };
        await emit(ev);
        throw new ZeroGUnavailable("0G intent: response has no choices[0].message", ev);
      }
      const v = validateIntentOutput(first.message.content, allowList, mode);
      // The refusal code (fixed enum) goes into the evidence; the model's text never does.
      const evidence: Evidence = v.ok ? r.evidence : { ...r.evidence, refusal: v.reason };
      await emit(evidence);
      return v.ok
        ? { refused: false, intent: v.intent, requestId: r.requestId, evidence }
        : { refused: true, reason: v.reason, requestId: r.requestId, evidence };
    },

    async speak(text) {
      if (!isTemplateText(text)) throw new Error("speak(): text is not a replyText() template; refusing to send it to TTS");
      const ttsModel = model(opts.ttsModel, "ZG_TTS_MODEL");
      // ZG_TTS_VOICE: a voice id from GET /v1/models speech_capabilities.voices
      if (!opts.ttsVoice) throw new ZeroGNotConfigured("ZG_TTS_VOICE");
      const ttsTrust = opts.ttsTrustMode ?? "standard";
      const r = await call({
        kind: "speak",
        model: ttsModel,
        trustMode: ttsTrust,
        path: "/audio/speech",
        sendTrustHeader: ttsTrust === "verified" || ttsTrust === "private",
        expect: "audio",
        body: { model: ttsModel, input: text, voice: opts.ttsVoice, response_format: ttsFormat },
      });
      await emit(r.evidence);
      return { audio: r.audio!, mime: r.mime || `audio/${ttsFormat === "mp3" ? "mpeg" : ttsFormat}`, requestId: r.requestId, evidence: r.evidence };
    },
  };
}

/** Build a client from ZG_* env vars (server-side only). Throws if the key is missing. */
export function createRouterClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<RouterClientOptions> = {},
): RouterClient {
  const apiKey = env.ZG_ROUTER_API_KEY ?? "";
  if (!apiKey || apiKey === "sk-") throw new Error("ZG_ROUTER_API_KEY is not set");
  const timeoutMs = Number(env.ZG_TIMEOUT_MS ?? "8000");
  return createRouterClient({
    baseUrl: env.ZG_ROUTER_BASE_URL || "https://router-api.0g.ai/v1",
    apiKey,
    trustMode: env.ZG_TRUST_MODE || "private",
    sttTrustMode: env.ZG_STT_TRUST_MODE || undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000,
    sttModel: env.ZG_STT_MODEL || undefined,
    intentModel: env.ZG_INTENT_MODEL || undefined,
    intentTrustMode: env.ZG_INTENT_TRUST_MODE || undefined,
    ttsModel: env.ZG_TTS_MODEL || undefined,
    ttsVoice: env.ZG_TTS_VOICE || undefined,
    ttsTrustMode: env.ZG_TTS_TRUST_MODE || undefined,
    ttsFormat: env.ZG_TTS_FORMAT || undefined,
    verifyTee: env.ZG_VERIFY_TEE ? env.ZG_VERIFY_TEE !== "false" : undefined,
    evidencePath: env.ZG_EVIDENCE_PATH || undefined,
    ...overrides,
  });
}
