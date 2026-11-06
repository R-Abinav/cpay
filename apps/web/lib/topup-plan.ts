// "Top up privately" as explicit steps (pure; tested). A top-up is the public transactions that move USDC (and,
// when the fee balance is low, WETH) from the agent wallet into Railgun, then the wait for Railgun's privacy
// check (POI) until the deposit is spendable.
//
// Never send a step twice: a step is signed once; its signed bytes and hash are kept. A retry first looks for
// that hash on chain and, if the node doesn't know it, rebroadcasts the SAME bytes (same nonce, same hash), so a
// flaky RPC can never cause a second transfer. Only a step that is final-failed (reverted on chain, or its
// nonce was taken by another transaction) is prepared again, and only for the token whose deposit isn't done.
import type { PrivateBalances, TxData } from "./railgun-types.js";

export type Token = "USDC" | "WETH";
export type StepKind = "wrap" | "approve" | "deposit";
export type StepStatus = "todo" | "active" | "done" | "failed";

export interface Step {
  token: Token;
  kind: StepKind;
  tx: TxData;
  status: StepStatus;
  /** Signed bytes + hash, kept from the first signature on: a retry never signs this step again. */
  raw?: `0x${string}`;
  hash?: `0x${string}`;
  nonce?: number;
  error?: string;
  /** Final: reverted on chain or replaced. Only these are prepared again. */
  final?: boolean;
}

export type Stage = "preparing" | "sending" | "poi" | "spendable" | "failed" | "slow";

export interface TopUp {
  /** USDC (6 decimals) and WETH (18) being deposited */
  amounts: Partial<Record<Token, bigint>>;
  /** spendable (POI-valid) balances when the top-up started */
  baseline: { usdc: bigint; weth: bigint };
  steps: Step[];
  stage: Stage;
  /** where it failed when stage = "failed" */
  failedAt?: "prepare" | "step" | "poi";
  error?: string;
  poiStartedAt?: number;
}

/** About how long Railgun's testnet POI check takes after a deposit (measured ~100 s). */
export const POI_EXPECT_MS = 120_000;
/** Stop polling after this; the funds are safe and the user can refresh later. */
export const POI_GIVE_UP_MS = 15 * 60_000;

const WRAP = "0xd0e30db0"; // WETH.deposit()
const APPROVE = "0x095ea7b3"; // ERC-20 approve(address,uint256)

export function classifyTx(tx: TxData, weth: string): StepKind {
  const sel = tx.data.slice(0, 10).toLowerCase();
  if (sel === WRAP && tx.to.toLowerCase() === weth.toLowerCase()) return "wrap";
  if (sel === APPROVE) return "approve";
  return "deposit";
}

export function stepsOf(token: Token, txs: readonly TxData[], weth: string): Step[] {
  const steps = txs.map((tx): Step => ({ token, kind: classifyTx(tx, weth), tx, status: "todo" }));
  if (steps.filter((s) => s.kind === "deposit").length !== 1 || steps[steps.length - 1]!.kind !== "deposit") {
    throw new Error("unexpected deposit shape");
  }
  return steps;
}

export function newTopUp(amounts: TopUp["amounts"], baseline: TopUp["baseline"]): TopUp {
  return { amounts, baseline, steps: [], stage: "preparing" };
}

const LABELS: Record<StepKind, (tok: Token) => [ing: string, done: string, name: string]> = {
  wrap: () => ["Wrapping ETH", "Wrapped ETH", "ETH wrap"],
  approve: (tok) => [`Approving ${tok}`, `Approved ${tok}`, `${tok} approval`],
  deposit: (tok) => [`Depositing ${tok}`, `Deposited ${tok}`, `${tok} deposit`],
};

/** The step's line in the progress list. */
export function stepLabel(s: Step): string {
  const [ing, done] = LABELS[s.kind](s.token);
  return s.status === "done" ? done : s.status === "failed" ? `${ing} failed` : `${ing}…`;
}

/** Short noun for toasts ("USDC deposit sent"). */
export function stepName(s: Pick<Step, "kind" | "token">): string {
  return LABELS[s.kind](s.token)[2];
}

export type Action =
  | { do: "prepare"; tokens: Token[] }
  | { do: "send"; i: number }
  | { do: "resume"; i: number }
  | { do: "poi" }
  | { do: "none" };

/** Tokens whose deposit step is not done yet. */
function undeposited(t: TopUp): Token[] {
  return (Object.keys(t.amounts) as Token[]).filter((tok) => !t.steps.some((s) => s.token === tok && s.kind === "deposit" && s.status === "done"));
}

/** What to do next (also what "Retry" does). */
export function nextAction(t: TopUp): Action {
  if (t.stage === "spendable") return { do: "none" };
  const finalFailed = t.steps.find((s) => s.final && s.status === "failed");
  if (finalFailed) return { do: "prepare", tokens: undeposited(t) };
  if (t.steps.length === 0) return { do: "prepare", tokens: undeposited(t) };
  const i = t.steps.findIndex((s) => s.status !== "done");
  if (i === -1) return { do: "poi" };
  return t.steps[i]!.raw ? { do: "resume", i } : { do: "send", i };
}

/**
 * A new top-up may start (or this one be dismissed) only when no step is possibly in flight: every signed step
 * is either done or final-failed. Otherwise the user must Retry, which settles that exact transaction first.
 */
export function canStartNew(t: TopUp): boolean {
  if (t.stage === "spendable" || t.stage === "slow") return true;
  if (t.stage !== "failed") return false;
  return t.steps.every((s) => !s.raw || s.status === "done" || s.final === true);
}

/** Lowest nonce the next signature may use: after every step already signed (public RPCs can lag a block). */
export function minNonce(t: TopUp): number {
  let n = 0;
  for (const s of t.steps) if (s.nonce !== undefined && !s.final) n = Math.max(n, s.nonce + 1);
  return n;
}

// ---- transitions (return a new TopUp; the runner stores it) ----

/** Replace every not-done step of `tokens` with freshly prepared ones (done steps and other tokens stay). */
export function withPrepared(t: TopUp, fresh: Step[]): TopUp {
  const tokens = new Set(fresh.map((s) => s.token));
  const kept = t.steps.filter((s) => s.status === "done" || !tokens.has(s.token));
  // keep token order: done steps first in their original order, then the fresh ones
  return { ...t, steps: [...kept, ...fresh], stage: "sending", failedAt: undefined, error: undefined };
}

const at = (t: TopUp, i: number, p: Partial<Step>): TopUp => ({ ...t, steps: t.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });

export const onActive = (t: TopUp, i: number): TopUp => ({ ...at(t, i, { status: "active", error: undefined }), stage: "sending", failedAt: undefined, error: undefined });
export const onSigned = (t: TopUp, i: number, p: { raw: `0x${string}`; hash: `0x${string}`; nonce: number }): TopUp => at(t, i, p);
export const onConfirmed = (t: TopUp, i: number): TopUp => at(t, i, { status: "done", error: undefined });
export function onStepFailed(t: TopUp, i: number, error: string, final = false): TopUp {
  return { ...at(t, i, { status: "failed", error, final }), stage: "failed", failedAt: "step", error };
}
export const onPrepareFailed = (t: TopUp, error: string): TopUp => ({ ...t, stage: "failed", failedAt: "prepare", error });
export const onPoiStart = (t: TopUp, now: number): TopUp => ({ ...t, stage: "poi", poiStartedAt: t.poiStartedAt ?? now, failedAt: undefined, error: undefined });
export const onPoiFailed = (t: TopUp, error: string): TopUp => ({ ...t, stage: "failed", failedAt: "poi", error });
export const onSpendable = (t: TopUp): TopUp => ({ ...t, stage: "spendable", error: undefined });
export const onSlow = (t: TopUp): TopUp => ({ ...t, stage: "slow" });

/** The deposited amounts are now POI-valid (spendable) on top of the baseline. */
export function isSpendable(t: TopUp, b: PrivateBalances): boolean {
  const usdc = t.amounts.USDC ?? 0n;
  const weth = t.amounts.WETH ?? 0n;
  return b.usdc.valid >= t.baseline.usdc + usdc && b.weth.valid >= t.baseline.weth + weth;
}

/** Seconds left on the "~2 min" countdown (0 once it's over; the UI then says it's taking longer). */
export function poiSecondsLeft(t: TopUp, now: number): number {
  if (t.poiStartedAt === undefined) return Math.ceil(POI_EXPECT_MS / 1000);
  return Math.max(0, Math.ceil((t.poiStartedAt + POI_EXPECT_MS - now) / 1000));
}

export function poiGiveUp(t: TopUp, now: number): boolean {
  return t.poiStartedAt !== undefined && now - t.poiStartedAt >= POI_GIVE_UP_MS;
}

/** One line under the private balance explaining a zero spendable balance (null when nothing to explain). */
export function balanceHint(b: PrivateBalances | undefined, used: boolean): string | null {
  const nothing = !b || (b.usdc.valid === 0n && b.usdc.pending === 0n && b.weth.valid === 0n && b.weth.pending === 0n);
  if (!used || (b && nothing)) {
    return "Sending ETH/USDC to your wallet is public balance. Tap Top up privately to move it into your private balance.";
  }
  if (b && b.usdc.valid === 0n && b.usdc.pending > 0n) {
    return "Pending funds wait for Railgun's privacy check (about 2 min after a deposit) before you can spend them.";
  }
  return null;
}
