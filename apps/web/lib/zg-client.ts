"use client";
// Browser calls to our 0G proxy routes. ALL shapes for /api/intent, /api/transcribe, /api/speak live here,
// so they can be adjusted in one place at merge. Every call carries the hub ticket (x-cpay-ticket).
// 0G returns {amount, token} only; the destination never goes to 0G (invariant 7).
import { z } from "zod";

export class BrainOffline extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "BrainOffline";
  }
}

/** What the scan log shows per 0G call: request ID + receipt status. Never audio or text. */
export interface EvidenceLine {
  kind: string;
  requestId: string | null;
  receipt: string;
}

const Evidence = z.looseObject({
  kind: z.string().optional(),
  requestId: z.string().nullable().optional(),
  receipt: z.unknown().optional(),
  receiptStatus: z.string().optional(),
  rawTrace: z.unknown().optional(),
});

function receiptStatus(e: z.infer<typeof Evidence>): string {
  if (e.receiptStatus) return e.receiptStatus;
  const r = e.receipt as Record<string, unknown> | null | undefined;
  if (r && typeof r === "object") {
    if (typeof r.status === "string") return r.status;
    if (typeof r.verified === "boolean") return r.verified ? "verified" : "unverified";
    return "present";
  }
  const t = e.rawTrace as Record<string, unknown> | null | undefined;
  if (t && typeof t === "object" && "tee_verified" in t) return t.tee_verified ? "tee_verified" : "tee_unverified";
  return "missing";
}

function evidenceLines(raw: unknown): EvidenceLine[] {
  const arr = z.array(Evidence).safeParse(raw);
  if (!arr.success) return [];
  return arr.data.map((e) => ({ kind: e.kind ?? "?", requestId: e.requestId ?? null, receipt: receiptStatus(e) }));
}

function filename(blob: Blob): string {
  const t = blob.type;
  return t.includes("mp4") ? "audio.mp4" : t.includes("ogg") ? "audio.ogg" : "audio.webm";
}

async function post(path: string, ticket: string | undefined, body: BodyInit, json = false): Promise<Response> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (ticket) headers["x-cpay-ticket"] = ticket;
  if (json) headers["content-type"] = "application/json";
  try {
    res = await fetch(path, {
      method: "POST",
      headers,
      body,
    });
  } catch (e) {
    throw new BrainOffline(e instanceof Error ? e.message : "network error");
  }
  if (res.status === 503) throw new BrainOffline("zg_unavailable");
  return res;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const IntentShape = z.object({ amount: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/), token: z.string().min(1).max(12) });

export type IntentResult =
  | { kind: "intent"; amount: string; token: string; evidence: EvidenceLine[] }
  | { kind: "refusal"; evidence: EvidenceLine[] };

/** POST /api/intent (multipart: audio). 503 -> BrainOffline. Anything not a clean {amount, token} is a refusal. */
export async function intentFromAudio(audio: Blob, ticket: string): Promise<IntentResult> {
  const fd = new FormData();
  fd.append("audio", audio, filename(audio));
  const res = await post("/api/intent", ticket, fd);
  const j = await readJson(res);
  const evidence = evidenceLines(j.evidence);
  if (j.error === "zg_unavailable") throw new BrainOffline("zg_unavailable");
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new BrainOffline("hub ticket rejected");
    return { kind: "refusal", evidence };
  }
  const intent = IntentShape.safeParse(j.intent);
  if (!intent.success) return { kind: "refusal", evidence };
  return { kind: "intent", amount: intent.data.amount, token: intent.data.token.toUpperCase(), evidence };
}

/** POST /api/transcribe (multipart: audio) -> transcript (kept in memory only, never logged). */
export async function transcribe(audio: Blob, ticket: string): Promise<{ text: string; evidence: EvidenceLine[] }> {
  const fd = new FormData();
  fd.append("audio", audio, filename(audio));
  const res = await post("/api/transcribe", ticket, fd);
  const j = await readJson(res);
  const evidence = evidenceLines(j.evidence);
  if (!res.ok) {
    if (j.error === "zg_unavailable" || res.status >= 500) throw new BrainOffline(String(j.error ?? res.status));
    return { text: "", evidence };
  }
  return { text: typeof j.text === "string" ? j.text : "", evidence };
}

/** Reply templates (fixed text on the server; we send only the template ID + numbers). */
export type SpeakTemplate =
  | "ack"
  | "noQr"
  | "notWalletQr"
  | "wrongNetwork"
  | "sayAmountAgain"
  | "needApproval"
  | "confirmPrompt"
  | "confirmAgain"
  | "paid"
  | "cancelled"
  | "denied"
  | "brainOffline"
  | "noVerifiedRecipient"
  | "sendingPrivately"
  | "confirmPromptPublic"
  | "noMatch"
  | "payFailed";

export interface SpokenReply {
  audio: ArrayBuffer;
  mime: string;
  evidence: EvidenceLine[];
}

/** Only amount + token may go to TTS (as strings). The one-time confirm code can never be sent (it is OLED-only). */
export function speakParams(params: Record<string, string | number>): { amount?: string; token?: string } {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([k]) => k === "amount" || k === "token")
      .map(([k, v]) => [k, String(v)]),
  );
}

/**
 * POST /api/speak -> audio + 0G evidence. Returns null on any failure: the caller then shows the same
 * fixed text on screen at once (voice unavailable is visible, never silent, never faked).
 */
export async function speakAudio(
  template: SpeakTemplate,
  params: Record<string, string | number> = {},
  ticket?: string,
): Promise<SpokenReply | null> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ticket) headers["x-cpay-ticket"] = ticket;
    const res = await fetch("/api/speak", {
      method: "POST",
      headers,
      body: JSON.stringify({ template, ...speakParams(params) }),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return { audio: await res.arrayBuffer(), mime: type || "audio/mpeg", evidence: [] };
    const j = (await res.json()) as { audioBase64?: string; mime?: string; evidence?: unknown };
    if (!j.audioBase64) return null;
    const bin = atob(j.audioBase64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { audio: out.buffer, mime: typeof j.mime === "string" ? j.mime : "audio/mpeg", evidence: evidenceLines(j.evidence) };
  } catch {
    return null;
  }
}

/** GET /api/evidence: the public 0G evidence list (no user data). */
export async function fetchEvidence(): Promise<Record<string, unknown>[]> {
  const res = await fetch("/api/evidence", { cache: "no-store" });
  if (!res.ok) throw new Error(`evidence: HTTP ${res.status}`);
  const j = (await res.json()) as unknown;
  const list = Array.isArray(j) ? j : ((j as { evidence?: unknown; rows?: unknown }).evidence ?? (j as { rows?: unknown }).rows);
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}
