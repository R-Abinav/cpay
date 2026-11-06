"use client";
// Wallet tab: money received privately sits on one-time addresses (one per payment). Listing them is local;
// reading their balances asks the RPC about all of them at once (it could link them), so it runs only on tap.
// Sweeping moves one to the agent wallet and links the two on-chain: the button says so.
import { useEffect, useState } from "react";
import { NotConnectedError, addressUrl, oneTimeBalances, oneTimeCount, sweepToAgent, txUrl, type OneTimeBalance, type UnlockedWallet } from "../lib/wallet.js";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PrivateBalances({ wallet, onSwept }: { wallet: UnlockedWallet; onSwept?: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [rows, setRows] = useState<OneTimeBalance[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; amount: string } | null>(null);

  useEffect(() => {
    oneTimeCount().then(setCount, (e) => (e instanceof NotConnectedError ? setNotConnected(e.message) : setErr(msg(e))));
  }, []);

  async function check() {
    setBusy("check");
    setErr(null);
    try {
      setRows(await oneTimeBalances());
    } catch (e) {
      if (e instanceof NotConnectedError) setNotConnected(e.message);
      else setErr(`Balances unavailable: ${msg(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function sweep(r: OneTimeBalance) {
    if (
      !confirm(
        `Sweep ${r.usdc} USDC from ${short(r.address)} to your agent wallet?\n\nThis links the one-time address to your agent wallet on-chain: anyone can then see they belong together.`,
      )
    )
      return;
    setBusy(r.address);
    setErr(null);
    try {
      const res = await sweepToAgent(wallet, r.address);
      setDone(res);
      onSwept?.();
      setRows(await oneTimeBalances());
    } catch (e) {
      setErr(`Sweep failed: ${msg(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const total = rows ? rows.reduce((s, r) => s + r.usdcRaw, 0n) : null;
  const fmt = (v: bigint) => {
    const s = v.toString().padStart(7, "0");
    const f = s.slice(-6).replace(/0+$/, "");
    return f ? `${s.slice(0, -6)}.${f}` : s.slice(0, -6);
  };

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h2 className="text-lg font-semibold">Private balance</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Money paid to your private CPay QR or face lands on a fresh one-time address each time.{" "}
        {count !== null && `${count} on this phone.`}
      </p>
      {notConnected ? (
        <p className="mt-3 text-sm text-amber-200">Not connected: {notConnected}</p>
      ) : (
        <>
          {total !== null && (
            <p className="mt-3 text-3xl font-bold">
              {fmt(total)} <span className="text-lg text-neutral-400">USDC</span>
            </p>
          )}
          <button
            onClick={check}
            disabled={busy !== null || count === 0}
            className="mt-3 min-h-12 w-full rounded-xl bg-neutral-800 px-4 font-semibold disabled:opacity-40"
          >
            {busy === "check" ? "Checking…" : rows ? "Refresh private balances" : "Check private balances"}
          </button>
          <p className="mt-1 text-xs text-neutral-500">Asks the RPC about all your one-time addresses at once (it could link them).</p>
          {rows && rows.length > 0 && (
            <ul className="mt-3 space-y-2">
              {rows.map((r) => (
                <li key={r.address} className="flex items-center justify-between gap-2 rounded-xl bg-neutral-950 px-3 py-2 text-sm">
                  <a href={addressUrl(r.address)} target="_blank" rel="noreferrer noopener" className="font-mono underline">
                    {short(r.address)}
                  </a>
                  <span className="text-neutral-300">{r.usdc} USDC</span>
                  <button
                    onClick={() => sweep(r)}
                    disabled={busy !== null || r.usdcRaw === 0n}
                    className="rounded-lg bg-amber-500/20 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-30"
                  >
                    {busy === r.address ? "Sweeping…" : "Sweep to agent wallet (links them on-chain)"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {done && (
        <p className="mt-3 text-sm text-emerald-300">
          Swept {done.amount} USDC ·{" "}
          <a className="underline" href={txUrl(done.hash)} target="_blank" rel="noreferrer noopener">
            tx ↗
          </a>
        </p>
      )}
      {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
    </section>
  );
}
