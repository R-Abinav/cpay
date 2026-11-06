"use client";
// Wallet tab: the Railgun private balance (payer hiding) + "Top up privately" (shield from the agent wallet,
// signed on this phone). Only real numbers from the Railgun client; if it isn't available, this says so.
import { useState, useSyncExternalStore } from "react";
import { WETH_FEE_LOW, WETH_FEE_TOPUP, getRailgun, railgunStore, refreshPrivate } from "../lib/railgun.js";
import type { TxData } from "../lib/railgun-types.js";
import { errText, toast } from "../lib/toast.js";
import { fmtUnits, sendTxs, toBaseUnits, txUrl, type UnlockedWallet } from "../lib/wallet.js";

const short = (a: string) => (a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);

export function RailgunBalance({ wallet, onDeposited }: { wallet: UnlockedWallet; onDeposited?: () => void }) {
  const rg = useSyncExternalStore(railgunStore.subscribe, railgunStore.get, railgunStore.get);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const b = rg.balances;

  const refresh = () => void refreshPrivate(wallet).catch((e) => toast.error(`Private balance: ${errText(e)}`));

  async function topUp() {
    const base = toBaseUnits(amount.trim());
    if (base === null || base <= 0n) return toast.error("Enter a USDC amount");
    setBusy(true);
    try {
      const client = await getRailgun(wallet);
      const txs: TxData[] = await client.prepareShield({ token: "USDC", amount: base, from: wallet.address });
      const weth = b ? b.weth.valid + b.weth.pending : 0n;
      if (weth < WETH_FEE_LOW) txs.push(...(await client.prepareShield({ token: "WETH", amount: WETH_FEE_TOPUP, from: wallet.address })));
      await sendTxs(wallet, txs, (hash, i) => toast.info(`Deposit tx ${i + 1}/${txs.length} sent`, { href: txUrl(hash), label: "View tx" }));
      toast.success("Deposited. Spendable in about 1–4 min.");
      setAmount("");
      onDeposited?.();
      refresh();
    } catch (e) {
      toast.error(`Top up failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Private balance (Railgun)" className="border-t border-neutral-900 pt-6">
      <h2 className="text-base font-semibold">Private balance (Railgun)</h2>
      {rg.status === "unavailable" ? (
        <p className="mt-2 text-sm text-amber-300">Private payments unavailable{rg.error ? `: ${rg.error}` : ""}</p>
      ) : (
        <>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">{b ? fmtUnits(b.usdc.valid, 6) : "…"}</span>
            <span className="text-neutral-500">USDC spendable</span>
          </p>
          {b && b.usdc.pending > 0n && (
            <p className="mt-1 text-sm text-neutral-400">+{fmtUnits(b.usdc.pending, 6)} USDC pending (spendable ~1–4 min after a deposit)</p>
          )}
          <p className="mt-1 text-sm tabular-nums text-neutral-400">{b ? fmtUnits(b.weth.valid + b.weth.pending, 18) : "…"} WETH for fees</p>
          {rg.address && (
            <button
              onClick={() => void navigator.clipboard?.writeText(rg.address!).then(() => toast.info("0zk address copied"), () => toast.error("Couldn't copy"))}
              className="mt-3 min-h-11 w-full rounded-xl border border-neutral-900 px-4 py-2 text-left font-mono text-xs text-neutral-300"
              aria-label="Copy 0zk address"
            >
              {short(rg.address)} · copy
            </button>
          )}
          <div className="mt-4 flex gap-2">
            <input
              inputMode="decimal"
              placeholder="USDC"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="min-h-12 w-full min-w-0 rounded-xl border border-neutral-800 bg-transparent px-4"
            />
            <button
              onClick={() => void topUp()}
              disabled={busy || rg.status !== "ready"}
              className="min-h-12 shrink-0 rounded-xl bg-emerald-500 px-4 font-semibold text-black disabled:opacity-40"
            >
              {busy ? "Sending…" : "Top up privately"}
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-300/80">Deposits are public; payments from your private balance aren&apos;t linked to them.</p>
        </>
      )}
      <button onClick={refresh} disabled={rg.syncing} className="mt-3 min-h-11 w-full rounded-xl border border-neutral-800 text-sm disabled:opacity-40">
        {rg.syncing ? "Syncing…" : rg.status === "unavailable" ? "Retry" : "Refresh private balance"}
      </button>
    </section>
  );
}
