// Dependency status: how the UI tells "not connected" (unwired stub / missing config) from a live failure.
import { z } from "zod";

/** The workspace stubs throw exactly this until their owners implement them. */
export function isNotImplemented(e: unknown): boolean {
  return e instanceof Error && e.message === "not implemented";
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

export const DependencyId = z.enum([
  "zerog",
  "zerog-storage",
  "credential",
  "world-idkit",
  "agent-pass",
  "issuer",
  "relay",
  "chain",
  "agent-wallet",
  "injected-wallet",
  "face-model",
]);
export type DependencyId = z.infer<typeof DependencyId>;

export const DependencyState = z.enum(["ok", "not_connected", "offline", "unknown"]);
export type DependencyState = z.infer<typeof DependencyState>;

export const DependencyStatus = z.object({
  id: DependencyId,
  state: DependencyState,
  detail: z.string(),
});
export type DependencyStatus = z.infer<typeof DependencyStatus>;

export const DEPENDENCY_LABEL: Record<DependencyId, string> = {
  zerog: "0G router (ears, brain, voice)",
  "zerog-storage": "0G Storage (episode log)",
  credential: "BBS credential (@cpay/credential)",
  "world-idkit": "World IDKit",
  "agent-pass": "World Agent Pass",
  issuer: "Issuer",
  relay: "Relay",
  chain: "Sepolia RPC",
  "agent-wallet": "Agent wallet",
  "injected-wallet": "Wallet (EIP-1193)",
  "face-model": "Face model",
};

/** Where a stage stopped. Every non-ok API response carries one of these. */
export const StopState = z.enum([
  "brain_offline", // 0G unreachable or @cpay/zerog not wired -> BRAIN OFFLINE - PAUSED
  "not_connected", // a dependency is unwired or unconfigured
  "refused", // 0G understood nothing payable
  "policy_denied",
  "approval_required",
  "approval_denied",
  "proof_invalid",
  "bad_request",
  "already_paid",
  "chain_error",
  "error",
]);
export type StopState = z.infer<typeof StopState>;
