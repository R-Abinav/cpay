"use client";
// Runs "Top up privately" step by step (plan + rules in topup-plan.ts) and keeps its progress in memory for this
// tab, so leaving the Wallet tab doesn't lose it. Lock clears it. Every transaction is signed on this phone by the
// agent wallet; nothing here talks to our servers.
import { WETH_ADDRESS, WETH_FEE_LOW, WETH_FEE_TOPUP, getRailgun, markRailgunUsed, privateBalances, refreshPrivate } from "./railgun.js";
import * as P from "./topup-plan.js";
import { errText, toast } from "./toast.js";
import { broadcastTx, checkTx, onWallet, signTx, txUrl, waitTx, type UnlockedWallet } from "./wallet.js";

let cur: { wallet: UnlockedWallet; t: P.TopUp } | null = null;
let running = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

let watching = false;
function watchLock(): void {
  if (watching) return;
  watching = true;
  onWallet((w) => {
    if (cur && cur.wallet !== w) {
      cur = null;
      emit();
    }
  });
}

export const topUpStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: (): P.TopUp | null => cur?.t ?? null,
  running: (): boolean => running,
};

const POLL_MS = 15_000;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Start a new private top-up of `usdc` (6 decimals). Adds a WETH fee deposit when spendable WETH is low. */
export async function startTopUp(wallet: UnlockedWallet, usdc: bigint, onDeposited?: () => void): Promise<void> {
  if (running || (cur && !P.canStartNew(cur.t))) return;
  watchLock();
  running = true; // claim before the first await
  // Show "Preparing deposit…" at once: the balance read below may wait behind a sync running in the worker.
  cur = { wallet, t: P.newTopUp({ USDC: usdc }, { usdc: 0n, weth: 0n }) };
  emit();
  try {
    await markRailgunUsed(wallet);
    const b = await privateBalances(wallet);
    // Only spendable WETH counts: on testnet, change from earlier payments never becomes spendable.
    const amounts: P.TopUp["amounts"] = b.weth.valid < WETH_FEE_LOW ? { USDC: usdc, WETH: WETH_FEE_TOPUP } : { USDC: usdc };
    if (cur?.wallet !== wallet) {
      running = false; // locked meanwhile
      return emit();
    }
    cur = { wallet, t: P.newTopUp(amounts, { usdc: b.usdc.valid, weth: b.weth.valid }) };
    emit();
  } catch (e) {
    running = false;
    if (cur?.wallet === wallet) cur = null; // nothing was signed: just let the user tap Top up again
    emit();
    toast.error(`Top up failed: ${errText(e)}`);
    return;
  }
  await drive(wallet, onDeposited);
}

/** Continue a failed top-up from where it stopped (never re-sends a transaction that may already be out). */
export async function retryTopUp(wallet: UnlockedWallet, onDeposited?: () => void): Promise<void> {
  if (running || !cur || cur.wallet !== wallet) return;
  running = true;
  await drive(wallet, onDeposited);
}

/** Hide a finished (spendable / slow / safely failed) top-up. */
export function dismissTopUp(): void {
  if (running || (cur && !P.canStartNew(cur.t))) return;
  cur = null;
  emit();
}

async function drive(wallet: UnlockedWallet, onDeposited: (() => void) | undefined): Promise<void> {
  const alive = () => cur?.wallet === wallet;
  const put = (f: (t: P.TopUp) => P.TopUp) => {
    if (!alive()) throw new Stopped();
    cur!.t = f(cur!.t);
    emit();
  };
  try {
    for (;;) {
      if (!alive()) return;
      const a = P.nextAction(cur!.t);
      if (a.do === "none") return;

      if (a.do === "prepare") {
        put((t) => ({ ...t, stage: "preparing", failedAt: undefined, error: undefined }));
        try {
          const client = await getRailgun(wallet);
          const fresh: P.Step[] = [];
          for (const token of a.tokens) {
            const amount = cur!.t.amounts[token]!;
            fresh.push(...P.stepsOf(token, await client.prepareShield({ token, amount, from: wallet.address }), WETH_ADDRESS));
          }
          put((t) => P.withPrepared(t, fresh));
        } catch (e) {
          if (e instanceof Stopped) return;
          put((t) => P.onPrepareFailed(t, errText(e)));
          toast.error(`Couldn't prepare the deposit: ${errText(e)}`);
          return;
        }
        continue;
      }

      if (a.do === "send" || a.do === "resume") {
        const i = a.i;
        put((t) => P.onActive(t, i));
        const label = `${P.stepName(cur!.t.steps[i]!)} (${i + 1}/${cur!.t.steps.length})`;
        try {
          let hash: `0x${string}`;
          if (a.do === "send") {
            const s = await signTx(wallet, cur!.t.steps[i]!.tx, P.minNonce(cur!.t));
            put((t) => P.onSigned(t, i, s)); // kept BEFORE broadcasting: a retry resends these exact bytes only
            await broadcastTx(s.raw);
            hash = s.hash;
            toast.info(`${label} sent`, { href: txUrl(hash), label: "View tx" });
          } else {
            const step = cur!.t.steps[i]!;
            hash = step.hash!;
            const st = await checkTx(wallet, hash, step.nonce!);
            if (st === "reverted" || st === "replaced") {
              put((t) => P.onStepFailed(t, i, st === "reverted" ? "reverted on chain" : "replaced by another transaction", true));
              toast.error(`${label} failed: ${st === "reverted" ? "reverted on chain" : "replaced"}`, { href: txUrl(hash), label: "View tx" });
              return;
            }
            if (st === "unknown") await broadcastTx(step.raw!); // same bytes, same hash: never a second transfer
          }
          if ((await waitTx(hash)) === "reverted") {
            put((t) => P.onStepFailed(t, i, "reverted on chain", true));
            toast.error(`${label} failed: reverted on chain`, { href: txUrl(hash), label: "View tx" });
            return;
          }
          put((t) => P.onConfirmed(t, i));
          toast.success(`${label} confirmed`, { href: txUrl(hash), label: "View tx" });
          if (cur!.t.steps[i]!.kind === "deposit") onDeposited?.();
        } catch (e) {
          if (e instanceof Stopped) return;
          put((t) => P.onStepFailed(t, i, errText(e)));
          toast.error(`${label} failed: ${errText(e)}`);
          return;
        }
        continue;
      }

      // a.do === "poi": wait for Railgun's privacy check, re-syncing every POLL_MS.
      put((t) => P.onPoiStart(t, Date.now()));
      let failures = 0;
      for (;;) {
        try {
          const b = await refreshPrivate(wallet);
          failures = 0;
          if (P.isSpendable(cur!.t, b)) {
            put(P.onSpendable);
            toast.success("Private balance ready to spend");
            return;
          }
        } catch (e) {
          if (e instanceof Stopped) return;
          if (++failures >= 3) {
            put((t) => P.onPoiFailed(t, errText(e)));
            toast.error(`Couldn't check the private balance: ${errText(e)}`);
            return;
          }
        }
        if (!alive()) return;
        if (P.poiGiveUp(cur!.t, Date.now())) {
          put(P.onSlow);
          return;
        }
        await sleep(POLL_MS);
      }
    }
  } catch (e) {
    if (!(e instanceof Stopped)) throw e;
  } finally {
    running = false;
    emit();
  }
}

class Stopped extends Error {}
