"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AddressQr } from "../components/address-qr.js";
import { GlassesPill } from "../components/app-shell.js";
import { PrivateBalances } from "../components/private-balances.js";
import { useWallet } from "../lib/hooks.js";
import { addressUrl, chain, getBalances, hasWallet, lockWallet, unlockWallet } from "../lib/wallet.js";

export default function WalletPage() {
  const wallet = useWallet();
  const [exists, setExists] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bal, setBal] = useState<{ eth: string; usdc: string } | null>(null);
  const [balErr, setBalErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    hasWallet().then(setExists, (e) => {
      setExists(false);
      setErr(e instanceof Error ? e.message : String(e));
    });
  }, []);

  const refresh = useCallback(() => {
    if (!wallet) return;
    setBalErr(null);
    getBalances(wallet.address).then(setBal, (e) => setBalErr(e instanceof Error ? e.message : String(e)));
  }, [wallet]);
  useEffect(refresh, [refresh]);

  let chainId: number | null = null;
  try {
    chainId = chain().chainId;
  } catch {
    chainId = null;
  }

  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">CPay</h1>
        <GlassesPill />
      </header>

      {!wallet && (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
          <p className="text-lg font-semibold">{exists === false ? "No wallet on this phone yet" : "Wallet locked"}</p>
          <p className="mt-1 text-sm text-neutral-400">Your keys are made from your passkey, on this phone. Our servers never see them.</p>
          {exists === false ? (
            <Link href="/onboarding" className="mt-4 block rounded-xl bg-emerald-500 px-5 py-4 text-center text-lg font-semibold text-black">
              Create wallet
            </Link>
          ) : (
            <button
              disabled={exists === null}
              onClick={() => {
                setErr(null);
                unlockWallet().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
              }}
              className="mt-4 min-h-14 w-full rounded-xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
            >
              Unlock with passkey
            </button>
          )}
          {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
        </section>
      )}

      {wallet && (
        <>
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
            <p className="text-sm text-neutral-400">Agent wallet balance{chainId ? ` · chain ${chainId}` : ""}</p>
            <p className="mt-1 text-4xl font-bold">
              {bal ? bal.usdc : "…"} <span className="text-xl text-neutral-400">USDC</span>
            </p>
            <p className="mt-1 text-neutral-300">{bal ? bal.eth : "…"} ETH (gas)</p>
            {balErr && <p className="mt-2 text-sm text-red-300">Balance unavailable: {balErr}</p>}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Link href="/pay" className="rounded-xl bg-emerald-500 px-4 py-4 text-center text-lg font-semibold text-black">
                Pay
              </Link>
              <Link href="/receive" className="rounded-xl bg-neutral-800 px-4 py-4 text-center text-lg font-semibold">
                Receive
              </Link>
            </div>
          </section>

          <PrivateBalances wallet={wallet} onSwept={refresh} />

          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
            <h2 className="text-lg font-semibold">Top up your agent wallet</h2>
            <p className="mt-1 text-sm text-neutral-400">
              Send Base Sepolia USDC and a little ETH for gas. The balance is the most the agent can ever spend.
            </p>
            <div className="mt-4 flex justify-center">
              <AddressQr value={wallet.address} />
            </div>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(wallet.address).then(() => setCopied(true));
              }}
              className="mt-4 w-full break-all rounded-xl bg-neutral-950 px-4 py-3 font-mono text-sm"
            >
              {wallet.address}
            </button>
            <p className="mt-1 text-center text-xs text-neutral-500">{copied ? "Copied" : "Tap to copy"}</p>
            <p className="mt-2 text-xs text-amber-300/80">
              Funding from your main wallet links the two on-chain. Use a faucet or a fresh wallet to keep them apart.
            </p>
            <div className="mt-3 flex gap-3 text-sm">
              <button onClick={refresh} className="flex-1 rounded-xl bg-neutral-800 px-4 py-3">
                Refresh
              </button>
              <a href={addressUrl(wallet.address)} target="_blank" rel="noreferrer noopener" className="flex-1 rounded-xl bg-neutral-800 px-4 py-3 text-center">
                BaseScan ↗
              </a>
              <button onClick={lockWallet} className="flex-1 rounded-xl bg-neutral-800 px-4 py-3">
                Lock
              </button>
            </div>
          </section>
        </>
      )}

      <p className="text-center text-xs text-neutral-600">No analytics, no trackers, no CDN. Keys never leave this phone.</p>
    </main>
  );
}
