"use client";
// Wallet tab: money received privately sits on one-time addresses (one per payment). Listing them is local;
// reading their balances asks the RPC about all of them at once (it could link them), so it runs only on tap.
// "Send privately" pays straight from the one-time addresses (each signs its own transfer): the main wallet is
// never touched. "Move to private balance" shields into Railgun. "Move to main wallet" links the address to the agent wallet on-chain: the button says so.
import { useState, useEffect } from "react";
import { errText, toast } from "../lib/toast.js";
import {
  NotConnectedError,
  addressUrl,
  moveToPrivateBalance,
  oneTimeBalances,
  oneTimeCount,
  sweepToAgent,
  txUrl,
  type OneTimeBalance,
  type UnlockedWallet,
} from "../lib/wallet.js";
import { SendPrivately } from "./send-privately.js";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function PrivateBalances({ wallet, onSwept }: { wallet: UnlockedWallet; onSwept?: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [rows, setRows] = useState<OneTimeBalance[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState<string | null>(null);

  useEffect(() => {
    oneTimeCount().then(setCount, (e) => (e instanceof NotConnectedError ? setNotConnected(e.message) : toast.error(errText(e))));
  }, []);

  async function check() {
    setBusy("check");
    try {
      setRows(await oneTimeBalances());
    } catch (e) {
      if (e instanceof NotConnectedError) setNotConnected(e.message);
      else toast.error(`Private balances unavailable: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function moveToRailgun(r: OneTimeBalance) {
    setBusy(`railgun:${r.address}`);
    try {
      const res = await moveToPrivateBalance(wallet, r.address);
      toast.success(`Moved ${res.amount} USDC to your private balance`, { href: txUrl(res.hash), label: "View tx" });
      onSwept?.();
      setRows(await oneTimeBalances());
    } catch (e) {
      toast.error(`Move to private balance failed: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function moveToMain(r: OneTimeBalance) {
    if (
      !confirm(
        `Move ${r.usdc} USDC from ${short(r.address)} to your main (agent) wallet?\n\nThis PUBLICLY links the one-time address to your main wallet on-chain: anyone can then see they belong together. Its leftover gas ETH moves too.\n\nTo stay unlinked, use "Move to private balance" (Railgun) or "Send privately" instead.`,
      )
    )
      return;
    setBusy(`main:${r.address}`);
    try {
      const res = await sweepToAgent(wallet, r.address);
      toast.success(`Moved ${res.amount} USDC to your main wallet`, { href: txUrl(res.hash), label: "View tx" });
      if (res.ethHash) toast.info("Leftover gas ETH moved too", { href: txUrl(res.ethHash), label: "View tx" });
      onSwept?.();
      setRows(await oneTimeBalances());
    } catch (e) {
      toast.error(`Move failed: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const total = rows ? rows.reduce((s, r) => s + r.usdcRaw, 0n) : null;

  return (
    <section className="border-t border-neutral-900 pt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">Private balance</h2>
        {count !== null && <span className="text-xs text-neutral-500">{count} one-time address{count === 1 ? "" : "es"}</span>}
      </div>
      <p className="mt-1 text-sm text-neutral-400">Paid to your private QR or face: each payment lands on a fresh one-time address.</p>
      {notConnected ? (
        <p role="status" className="mt-3 text-sm text-amber-300">
          Not connected: {notConnected}
        </p>
      ) : (
        <>
          {total !== null && (
            <p className="mt-4 flex items-baseline gap-2">
              <span className="text-4xl font-semibold tabular-nums tracking-tight">{fmt(total)}</span>
              <span className="text-base text-neutral-500">USDC</span>
            </p>
          )}
          <button
            onClick={check}
            disabled={busy !== null || count === 0}
            className="mt-4 min-h-12 w-full rounded-xl border border-neutral-800 px-4 font-semibold disabled:opacity-40"
          >
            {busy === "check" ? "Checking…" : rows ? "Refresh private balances" : "Check private balances"}
          </button>
          <p className="mt-2 text-xs text-neutral-500">Asks the RPC about all your one-time addresses at once (it could link them).</p>

          {rows && total !== null && total > 0n && (
            <SendPrivately
              wallet={wallet}
              rows={rows}
              disabled={busy !== null}
              setBusy={setBusy}
              onSent={async () => setRows(await oneTimeBalances().catch(() => rows))}
            />
          )}

          {rows && rows.length > 0 && (
            <ul className="mt-4 divide-y divide-neutral-900 border-y border-neutral-900">
              {rows.map((r) => (
                <li key={r.address} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3 text-sm">
                  <a href={addressUrl(r.address)} target="_blank" rel="noreferrer noopener" className="font-mono text-neutral-300 underline">
                    {short(r.address)}
                  </a>
                  <span className="tabular-nums">{r.usdc} USDC</span>
                  <button
                    onClick={() => moveToRailgun(r)}
                    disabled={busy !== null || r.usdcRaw === 0n}
                    className="min-h-11 w-full rounded-xl bg-emerald-500 px-3 text-xs font-semibold text-black disabled:opacity-30"
                  >
                    {busy === `railgun:${r.address}` ? "Shielding…" : "Move to private balance (Railgun)"}
                  </button>
                  <button
                    onClick={() => moveToMain(r)}
                    disabled={busy !== null || r.usdcRaw === 0n}
                    className="min-h-11 w-full rounded-xl border border-amber-500/40 px-3 text-xs font-semibold text-amber-200 disabled:opacity-30"
                  >
                    {busy === `main:${r.address}` ? "Moving…" : "Move to main wallet (publicly links these addresses)"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function fmt(v: bigint): string {
  const s = v.toString().padStart(7, "0");
  const f = s.slice(-6).replace(/0+$/, "");
  return f ? `${s.slice(0, -6)}.${f}` : s.slice(0, -6);
}
