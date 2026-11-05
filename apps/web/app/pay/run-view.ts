// What /pay shows for the current push-to-talk run. Every field is filled from real data of this run only.
import type { EvidenceRecord, PayOk, PolicyJson, WalletJson } from "../../lib/api.js";
import type { DependencyId } from "../../lib/deps.js";

export type Phase =
  | "ready"
  | "listening"
  | "thinking"
  | "approval"
  | "probing"
  | "no_recipient"
  | "unverified"
  | "verifying"
  | "confirm"
  | "paying"
  | "paid"
  | "cancelled"
  | "approval_denied"
  | "policy_denied"
  | "refused"
  | "brain_offline"
  | "not_connected"
  | "error";

export const TERMINAL: readonly Phase[] = [
  "paid",
  "unverified",
  "cancelled",
  "approval_denied",
  "policy_denied",
  "refused",
  "brain_offline",
  "not_connected",
  "error",
];

export interface RunView {
  runId: string;
  phase: Phase;
  message: string;
  startedAt: number;
  transcript?: string;
  intent?: { amount: string; symbol: string; amountBase: string; tokenAddress: string; decimals: number; requestIds: string[] };
  wallet?: WalletJson;
  policy?: PolicyJson;
  approvalUrl?: string;
  approvalState?: "pending" | "approved" | "denied";
  sessionId?: string;
  shortCode?: string;
  qrDataUrl?: string;
  verified?: { tier: string; epoch: string };
  destination?: string;
  pay?: PayOk;
  rootHash?: string;
  storageTxHash?: string;
  episodeError?: string;
  evidence: EvidenceRecord[];
  voiceNote?: string;
  dependency?: { id: DependencyId; detail: string };
  relay: { peers: number; probeBytes: number; claimBytes: number; claims: number; probeAt?: number; claimAts: number[] };
  frame: { bytes: number; faces: number; source: "glasses" | "laptop" | null; deleted: boolean };
  issuerRequests: number;
  confirmSource?: "glasses" | "keyboard";
}

export function newRun(runId: string): RunView {
  return {
    runId,
    phase: "listening",
    message: "Listening…",
    startedAt: Date.now(),
    evidence: [],
    relay: { peers: 0, probeBytes: 0, claimBytes: 0, claims: 0, claimAts: [] },
    frame: { bytes: 0, faces: 0, source: null, deleted: false },
    issuerRequests: 0,
  };
}

/** Server responses carry the run's cumulative evidence; keep whichever list is longer (never drop records). */
export function mergeEvidence(current: EvidenceRecord[], incoming: EvidenceRecord[] | undefined): EvidenceRecord[] {
  if (!incoming || incoming.length === 0) return current;
  if (incoming.length >= current.length) return incoming;
  const key = (e: EvidenceRecord) => `${e.ts}|${e.kind}|${e.requestId}`;
  const seen = new Set(current.map(key));
  return [...current, ...incoming.filter((e) => !seen.has(key(e)))];
}
