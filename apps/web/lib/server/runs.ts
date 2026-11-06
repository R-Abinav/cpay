import "server-only";
// In-memory state of the agent runtime, keyed per push-to-talk "run". Lives on globalThis because Next
// may instantiate a module once per route bundle; every route must see the same maps.
// Holds IDs, hashes and policy results only: no audio, transcript, faces or addresses beyond the one-time destination.
import type { Evidence } from "@cpay/zerog";
import type { PolicyResult } from "../policy.js";
import { persistEvidence } from "./zg-evidence.js";

export interface RunPayment {
  sessionId: string;
  transferHash: string;
  gasDropHash: string | null;
  amount: string;
  token: string;
}

export interface Run {
  id: string;
  createdAt: number;
  evidence: Evidence[];
  timestamps: Record<string, string>;
  intent?: { amount: string; token: string; mode: string; amountBase: string };
  policy?: PolicyResult;
  payment?: RunPayment;
  decision?: string;
}

export interface AgentPassState {
  state: "pending" | "approved" | "denied";
  reason: string;
  binding: { sessionId: string; amount: string; token: string };
  at: number;
}

interface Store {
  runs: Map<string, Run>;
  agentPass: Map<string, AgentPassState>;
  payLock: Promise<unknown>;
}

const RUN_TTL_MS = 30 * 60_000;
const g = globalThis as typeof globalThis & { __cpayStore?: Store };
const store: Store = (g.__cpayStore ??= { runs: new Map(), agentPass: new Map(), payLock: Promise.resolve() });

function sweep(): void {
  const cutoff = Date.now() - RUN_TTL_MS;
  for (const [id, r] of store.runs) if (r.createdAt < cutoff) store.runs.delete(id);
  for (const [id, a] of store.agentPass) if (a.at < cutoff) store.agentPass.delete(id);
}

export function getRun(id: string): Run {
  sweep();
  let r = store.runs.get(id);
  if (!r) {
    r = { id, createdAt: Date.now(), evidence: [], timestamps: {} };
    store.runs.set(id, r);
  }
  return r;
}

export function stamp(run: Run, key: string): void {
  run.timestamps[key] = new Date().toISOString();
}

/**
 * Keep a 0G evidence record: on the run (-> episode + UI) and in the zg_evidence sink (one log line + one row).
 * Evidence never goes to disk: without the database the sink logs the line and says loudly that no row was stored.
 */
export async function keepEvidence(run: Run | null, ev: Evidence | undefined | null): Promise<void> {
  if (!ev) return;
  if (run) run.evidence.push(ev);
  await persistEvidence(ev);
}

export function setAgentPass(sessionId: string, s: Omit<AgentPassState, "at">): void {
  store.agentPass.set(sessionId, { ...s, at: Date.now() });
}

export function getAgentPass(sessionId: string): AgentPassState | undefined {
  sweep();
  return store.agentPass.get(sessionId);
}

/** Serialise payments so two concurrent requests can't both pass the daily cap. */
export function withPayLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = store.payLock.then(fn, fn);
  store.payLock = next.catch(() => undefined);
  return next;
}
