// @cpay/zerog: the agent's ears, brain and voice on 0G (router), plus the encrypted episode log on 0G Storage.
// STUB: interfaces only, owned by the zerog agent. Every function throws until implemented.
// No mocked decisions: any failure is a safe-stop (ZeroGUnavailable), never a fallback answer.

const notImplemented = (): never => {
  throw new Error("not implemented");
};

/** Thrown on network error, non-2xx, timeout or a missing request ID. The UI shows BRAIN OFFLINE - PAUSED. */
export class ZeroGUnavailable extends Error {
  override name = "ZeroGUnavailable";
  constructor(
    message: string,
    readonly evidence?: Evidence,
  ) {
    super(message);
  }
}

export type TrustMode = "private" | "verified" | (string & {});
export type EvidenceKind = "transcribe" | "intent" | "speak" | "storage";

/** One record per 0G call (docs/STACK.md "0G evidence"). IDs, receipts, model names and hashes only. */
export interface Evidence {
  ts: string;
  kind: EvidenceKind;
  model: string;
  trustMode: TrustMode;
  httpStatus: number | null;
  requestId: string | null;
  /** wherever 0G returns the signed receipt; field still to confirm */
  receipt: unknown | null;
  /** verbatim x_0g_trace body object */
  rawTrace: unknown | null;
  /** verbatim x-0g-* response headers */
  rawZgHeaders: Record<string, string>;
  rootHash?: string;
  txHash?: string;
}

export interface RouterClientOptions {
  baseUrl: string;
  apiKey: string;
  trustMode: TrustMode;
  timeoutMs: number;
  sttModel?: string;
  intentModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsTrustMode?: TrustMode;
}

export interface Intent {
  /** decimal string, e.g. "2" */
  amount: string;
  token: string;
  mode: "lite" | "full";
  recipientRef: "looked-at";
}

export type IntentResult =
  | { refused: false; intent: Intent; requestId: string; evidence: Evidence }
  | { refused: true; reason: string; requestId: string; evidence: Evidence };

export interface RouterClient {
  transcribe(audio: Blob | Uint8Array): Promise<{ text: string; requestId: string; evidence: Evidence }>;
  parseIntent(text: string): Promise<IntentResult>;
  /** `text` must come from replyText(); never LLM output, names or addresses. */
  speak(text: string): Promise<{ audio: ArrayBuffer; mime: string; requestId: string; evidence: Evidence }>;
}

export function createRouterClient(_opts: RouterClientOptions): RouterClient {
  return notImplemented();
}

export type ReplyTemplate =
  | "ack"
  | "needApproval"
  | "confirm"
  | "paid"
  | "cancelled"
  | "denied"
  | "noRecipient"
  | "brainOffline";

/** Fixed template replies, filled only with validated numbers. */
export function replyText(_template: ReplyTemplate, _values?: { amount?: string; token?: string }): string {
  return notImplemented();
}

/** Prints `[0g] kind=… model=… requestId=… receipt=…|missing` and appends to the JSONL at evidencePath. */
export function recordEvidence(_evidence: Evidence, _evidencePath: string): Promise<void> {
  return notImplemented();
}

export interface Episode {
  decision: string;
  requestIds: string[];
  receipts: unknown[];
  txHash: string | null;
  timestamps: Record<string, string>;
  policyResult: unknown;
}

export interface StorageOptions {
  rpcUrl: string;
  indexerUrl: string;
  privateKey: string;
  evidencePath: string;
}

/** AES-GCM encrypt the episode, upload to 0G Storage, index rootHash -> requestIds in the evidence file. */
export function logEpisode(
  _episode: Episode,
  _episodeKey: Uint8Array,
  _opts: StorageOptions,
): Promise<{ rootHash: string; txHash: string; evidence: Evidence }> {
  return notImplemented();
}
