// Wire schemas between /pay (browser) and the agent runtime (app/api/*). Both sides parse with these.
import { z } from "zod";
import { Address, UintString } from "@cpay/protocol";
import { DependencyId, DependencyStatus, StopState } from "./deps.js";

/** Mirror of @cpay/zerog's Evidence (IDs, receipts, model names, hashes only). Unknown fields are kept verbatim. */
export const EvidenceSchema = z.looseObject({
  ts: z.string(),
  kind: z.string(),
  model: z.string(),
  trustMode: z.string(),
  httpStatus: z.number().nullable(),
  requestId: z.string().nullable(),
  receipt: z.unknown().nullable(),
  rawTrace: z.unknown().nullable(),
  rawZgHeaders: z.record(z.string(), z.string()),
  rootHash: z.string().optional(),
  txHash: z.string().optional(),
});
export type EvidenceRecord = z.infer<typeof EvidenceSchema>;

export const RunId = z.uuid();

export const ApiFailure = z.object({
  ok: z.literal(false),
  stop: StopState,
  dependency: DependencyId.optional(),
  message: z.string(),
  evidence: z.array(EvidenceSchema).default([]),
});
export type ApiFailure = z.infer<typeof ApiFailure>;

// ---- /api/intent (multipart: audio, runId) ----
export const IntentOk = z.object({
  ok: z.literal(true),
  runId: RunId,
  transcript: z.string(),
  intent: z.object({ amount: z.string(), token: z.string(), mode: z.enum(["lite", "full"]) }),
  token: z.object({ symbol: z.string(), address: Address, decimals: z.number().int() }),
  amountBase: UintString,
  requestIds: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
});
export type IntentOk = z.infer<typeof IntentOk>;
export const IntentResponse = z.union([IntentOk, ApiFailure]);

// ---- /api/speak ----
export const ReplyTemplate = z.enum([
  "ack",
  "needApproval",
  "confirm",
  "paid",
  "cancelled",
  "denied",
  "noRecipient",
  "brainOffline",
]);
export type ReplyTemplate = z.infer<typeof ReplyTemplate>;
export const SpeakRequest = z.strictObject({
  runId: RunId,
  template: ReplyTemplate,
  amount: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).optional(),
  token: z.string().regex(/^[A-Z0-9]{1,8}$/).optional(),
});
export const SpeakOk = z.object({
  ok: z.literal(true),
  text: z.string(),
  mime: z.string(),
  audioBase64: z.string(),
  requestId: z.string(),
  evidence: z.array(EvidenceSchema),
});
export const SpeakResponse = z.union([SpeakOk, ApiFailure]);

// ---- payment view types (the Pay scan log; payments are signed on the phone) ----
export const PolicyCheckJson = z.object({ id: z.string(), ok: z.boolean(), approvable: z.boolean(), detail: z.string() });
export const PolicyJson = z.object({
  decision: z.enum(["allow", "needs_approval", "deny"]),
  checks: z.array(PolicyCheckJson),
  overPaymentCap: z.boolean(),
  overDailyCap: z.boolean(),
});
export type PolicyJson = z.infer<typeof PolicyJson>;

export const WalletJson = z.object({
  address: Address,
  tokenBalance: UintString.nullable(),
  ethBalance: UintString.nullable(),
  spentToday: UintString,
  paymentCap: UintString,
  dailyCap: UintString,
  decimals: z.number().int(),
  symbol: z.string(),
  rpcHost: z.string(),
});
export type WalletJson = z.infer<typeof WalletJson>;

export const PayOk = z.object({
  ok: z.literal(true),
  transferHash: z.string(),
  gasDropHash: z.string().nullable(),
  destination: Address,
  amountBase: UintString,
  symbol: z.string(),
  from: Address,
  verified: z.object({ tier: z.string(), epoch: z.string() }),
  policy: PolicyJson,
  approvalUsed: z.boolean(),
  rpcHost: z.string(),
  rpcCalls: z.array(z.string()),
});
export type PayOk = z.infer<typeof PayOk>;

// ---- /api/episode ----
export const EpisodeOutcome = z.enum(["paid", "cancelled", "approval_denied", "no_recipient", "policy_denied", "refused", "error"]);
export type EpisodeOutcome = z.infer<typeof EpisodeOutcome>;
export const EpisodeRequest = z.strictObject({ runId: RunId, outcome: EpisodeOutcome });
export const EpisodeOk = z.object({
  ok: z.literal(true),
  rootHash: z.string(),
  txHash: z.string(),
  requestIds: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
});
export const EpisodeResponse = z.union([EpisodeOk, ApiFailure]);

// ---- /api/agent-pass ----
export const SubHash = z.string().regex(/^[0-9a-f]{64}$/, "expected hex sha256");
/**
 * Salted sha256 commitment to the payment an approval unlocks (@cpay/wallet approvalBindingCommit).
 * The binding {sessionId, amount, token, to} and the salt stay on the phone; the server sees only this.
 */
export const BindingCommit = z.string().regex(/^[0-9a-f]{64}$/, "expected hex sha256");
/** POST /api/agent-pass/start body: link once (Settings), or approve one over-cap payment. */
export const AgentPassStartBody = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("link") }),
  z.strictObject({ mode: z.literal("approve"), bindingCommit: BindingCommit, subHash: SubHash }),
]);
export type AgentPassStartBody = z.infer<typeof AgentPassStartBody>;
export const AgentPassAttempt = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const AgentPassStartOk = z.object({ ok: z.literal(true), url: z.string().url(), attempt: AgentPassAttempt });
export const AgentPassStartResponse = z.union([AgentPassStartOk, ApiFailure]);
/** POST /api/agent-pass/status body. The attempt id never goes in a URL (access logs). */
export const AgentPassStatusBody = z.strictObject({ attempt: AgentPassAttempt, action: z.enum(["poll", "cancel"]) });
/** POST /api/agent-pass/status {action:"poll"}: pending, then the final result exactly once. */
export const AgentPassStatus = z.object({
  ok: z.literal(true),
  state: z.enum(["none", "pending", "done"]),
  approved: z.boolean().optional(),
  reason: z.string().optional(),
  mode: z.enum(["link", "approve"]).optional(),
  subHash: SubHash.optional(),
  token: z.string().max(4096).optional(),
});
export type AgentPassStatus = z.infer<typeof AgentPassStatus>;

// ---- /api/status ----
export const StatusResponse = z.object({ deps: z.array(DependencyStatus) });

/** Parse a fetch() result against a schema; network errors and bad shapes become ApiFailure. */
export async function readApi<T>(res: Response | Promise<Response>, schema: z.ZodType<T>): Promise<T | ApiFailure> {
  let body: unknown;
  try {
    body = await (await res).json();
  } catch (e) {
    return { ok: false, stop: "error", message: `agent runtime unreachable: ${(e as Error).message}`, evidence: [] };
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const fail = ApiFailure.safeParse(body);
  if (fail.success) return fail.data;
  return { ok: false, stop: "error", message: "unexpected response from agent runtime", evidence: [] };
}
