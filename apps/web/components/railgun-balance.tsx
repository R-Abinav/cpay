"use client";
// Wallet tab: the Railgun private balance (payer hiding) + "Top up privately" (shield from the agent wallet,
// signed on this phone), shown as clear steps with tx links, the Railgun check countdown and a Retry that
// never re-sends a transaction. Only real numbers from the Railgun client; if it isn't available, this says so.
import { useEffect, useState, useSyncExternalStore } from "react";
import { markRailgunUsed, railgunStore, railgunUsed, refreshPrivate } from "../lib/railgun.js";
import { dismissTopUp, retryTopUp, startTopUp, topUpStore } from "../lib/topup.js";
import { balanceHint, canStartNew, poiSecondsLeft, stepLabel, type Step, type TopUp } from "../lib/topup-plan.js";
import { errText, toast } from "../lib/toast.js";
import { fmtUnits, toBaseUnits, txUrl, type UnlockedWallet } from "../lib/wallet.js";

const short = (a: string) => (a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

type Dot = "todo" | "active" | "done" | "failed";
function Row({ dot, children, href }: { dot: Dot; children: React.ReactNode; href?: string }) {
  const color = { todo: "bg-neutral-700", active: "bg-amber-400 animate-pulse", done: "bg-emerald-500", failed: "bg-red-500" }[dot];
  return (
    <li className="flex min-h-8 items-center gap-3 text-sm">
      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
      <span className={dot === "todo" ? "text-neutral-500" : dot === "failed" ? "text-red-300" : "text-neutral-200"}>{children}</span>
      {href && (
        <a href={href} target="_blank" rel="noreferrer noopener" className="ml-auto text-xs text-neutral-400 underline">
          tx
        </a>
      )}
    </li>
  );
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function Progress({ t, onRetry, onDismiss }: { t: TopUp; onRetry: () => void; onDismiss: () => void }) {
  const running = useSyncExternalStore(topUpStore.subscribe, topUpStore.running, topUpStore.running);
  const now = useNow(t.stage === "poi");
  const depositsDone = t.steps.length > 0 && t.steps.every((s) => s.status === "done");
  const left = poiSecondsLeft(t, now);
  const poiDot: Dot = t.stage === "spendable" ? "done" : t.failedAt === "poi" ? "failed" : t.stage === "poi" || t.stage === "slow" ? "active" : "todo";
  const dot = (s: Step): Dot => s.status;
  return (
    <div className="mt-4 rounded-xl border border-neutral-800 p-4" aria-live="polite">
      <ol>
        {t.steps.length === 0 && <Row dot={t.failedAt === "prepare" ? "failed" : "active"}>Preparing deposit…</Row>}
        {t.steps.map((s, i) => (
          <Row key={i} dot={dot(s)} href={s.hash && s.raw ? txUrl(s.hash) : undefined}>
            {stepLabel(s)}
          </Row>
        ))}
        <Row dot={poiDot}>
          {t.stage === "spendable"
            ? "Railgun check passed"
            : t.stage === "slow"
              ? "Railgun check is taking longer than usual"
              : t.stage === "poi" && left > 0
                ? `Waiting for Railgun check (~2 min) · ${mmss(left)}`
                : t.stage === "poi"
                  ? "Waiting for Railgun check · taking a bit longer…"
                  : "Waiting for Railgun check (~2 min)"}
        </Row>
        <Row dot={t.stage === "spendable" ? "done" : "todo"}>Spendable</Row>
      </ol>
      {t.stage === "failed" && t.error && <p className="mt-2 text-sm text-red-300">{t.error}</p>}
      {t.stage === "slow" && <p className="mt-2 text-sm text-neutral-400">Your deposit is safe. Tap Refresh later to check again.</p>}
      {t.stage === "failed" && (
        <button onClick={onRetry} disabled={running} className="mt-3 min-h-11 w-full rounded-xl bg-emerald-500 font-semibold text-black disabled:opacity-40">
          {t.failedAt === "poi" ? "Check again" : t.steps.some((s) => s.final && s.status === "failed") ? "Prepare again" : "Retry"}
        </button>
      )}
      {canStartNew(t) && !running && (
        <button onClick={onDismiss} className="mt-2 min-h-11 w-full rounded-xl border border-neutral-800 text-sm">
          {t.stage === "failed" && !depositsDone ? "Dismiss" : "Done"}
        </button>
      )}
    </div>
  );
}

export function RailgunBalance({ wallet, onDeposited }: { wallet: UnlockedWallet; onDeposited?: () => void }) {
  const rg = useSyncExternalStore(railgunStore.subscribe, railgunStore.get, railgunStore.get);
  const topUp = useSyncExternalStore(topUpStore.subscribe, topUpStore.get, topUpStore.get);
  const running = useSyncExternalStore(topUpStore.subscribe, topUpStore.running, topUpStore.running);
  const [amount, setAmount] = useState("");
  const [used, setUsed] = useState(true);
  const b = rg.balances;

  useEffect(() => {
    let on = true;
    void railgunUsed(wallet).then((u) => on && setUsed(u), () => undefined);
    return () => {
      on = false;
    };
  }, [wallet, topUp]);

  // An explicit load/refresh (a tap) opts this wallet into background sync.
  const refresh = () =>
    void markRailgunUsed(wallet)
      .then(() => refreshPrivate(wallet))
      .catch((e) => toast.error(`Private balance: ${errText(e)}`));

  function topUpNow() {
    const base = toBaseUnits(amount.trim());
    if (base === null || base <= 0n) return void toast.error("Enter a USDC amount");
    setAmount("");
    void startTopUp(wallet, base, onDeposited);
  }

  const hint = rg.status === "ready" || rg.status === "locked" ? balanceHint(b, used) : null;
  const canNew = !running && (!topUp || canStartNew(topUp));

  return (
    <section aria-label="Private balance (Railgun)" className="border-t border-neutral-900 pt-6">
      <h2 className="text-base font-semibold">Private balance (Railgun)</h2>
      {rg.status === "unavailable" ? (
        <p className="mt-2 text-sm text-amber-300">Private payments unavailable{rg.error ? `: ${rg.error}` : ""}</p>
      ) : (
        <>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">{b ? fmtUnits(b.usdc.valid, 6) : rg.syncing || rg.status === "loading" ? "…" : "–"}</span>
            <span className="text-neutral-500">USDC spendable</span>
          </p>
          {b && b.usdc.pending > 0n && <p className="mt-1 text-sm tabular-nums text-neutral-400">{fmtUnits(b.usdc.pending, 6)} USDC pending</p>}
          <p className="mt-1 text-sm tabular-nums text-neutral-400">
            {b ? fmtUnits(b.weth.valid, 18) : "…"} WETH for fees
            {b && b.weth.pending > 0n ? ` · ${fmtUnits(b.weth.pending, 18)} pending` : ""}
          </p>
          {hint && <p className="mt-2 text-sm text-neutral-300">{hint}</p>}
          {rg.address && (
            <button
              onClick={() => void navigator.clipboard?.writeText(rg.address!).then(() => toast.info("0zk address copied"), () => toast.error("Couldn't copy"))}
              className="mt-3 min-h-11 w-full rounded-xl border border-neutral-900 px-4 py-2 text-left font-mono text-xs text-neutral-300"
              aria-label="Copy 0zk address"
            >
              {short(rg.address)} · copy
            </button>
          )}
          {topUp && (
            <Progress
              t={topUp}
              onRetry={() => void retryTopUp(wallet, onDeposited)}
              onDismiss={dismissTopUp}
            />
          )}
          {canNew && (
            <div className="mt-4 flex gap-2">
              <input
                inputMode="decimal"
                placeholder="USDC"
                aria-label="USDC amount to top up privately"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="min-h-12 w-full min-w-0 rounded-xl border border-neutral-800 bg-transparent px-4"
              />
              <button
                onClick={topUpNow}
                className="min-h-12 shrink-0 rounded-xl bg-emerald-500 px-4 font-semibold text-black disabled:opacity-40"
              >
                Top up privately
              </button>
            </div>
          )}
          <p className="mt-2 text-xs text-amber-300/80">
            Deposits are public. Payments from your private balance aren&apos;t directly linked to them, but similar amounts and
            timing can still link them.
          </p>
        </>
      )}
      <button onClick={refresh} disabled={rg.syncing} className="mt-3 min-h-11 w-full rounded-xl border border-neutral-800 text-sm disabled:opacity-40">
        {rg.syncing ? "Syncing…" : rg.status === "unavailable" ? "Retry" : rg.status === "locked" ? "Load private balance" : "Refresh private balance"}
      </button>
    </section>
  );
}
