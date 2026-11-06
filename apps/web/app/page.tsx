"use client";
// Wallet tab: the balance first, then private balances (send privately / move to main), then top-up.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AddressQr } from "../components/address-qr.js";
import { Page } from "../components/app-shell.js";
import { PrivateBalances } from "../components/private-balances.js";
import { RailgunCard } from "../components/railgun-card.js";
import { useWallet } from "../lib/hooks.js";
import { errText, toast } from "../lib/toast.js";
import { addressUrl, chain, getBalances, hasWallet, lockWallet, unlockWallet } from "../lib/wallet.js";

export default function WalletPage() {
  const wallet = useWallet();
  const [exists, setExists] = useState<boolean | null>(null);
  const [bal, setBal] = useState<{ eth: string; usdc: string } | null>(null);
  const [balErr, setBalErr] = useState(false);

  useEffect(() => {
    hasWallet().then(setExists, (e) => {
      setExists(false);
      toast.error(errText(e));
    });
  }, []);

  const refresh = useCallback(() => {
    if (!wallet) return;
    setBalErr(false);
    getBalances(wallet.address).then(setBal, (e) => {
      setBalErr(true);
      toast.error(`Balance unavailable: ${errText(e)}`);
    });
  }, [wallet]);
  useEffect(refresh, [refresh]);

  if (!wallet) {
    return (
      <Page>
        <section className="flex min-h-[55vh] flex-col justify-center gap-6">
          <div>
            <p className="text-3xl font-semibold tracking-tight">{exists === false ? "No wallet on this phone yet" : "Wallet locked"}</p>
            <p className="mt-2 text-neutral-400">Your keys are made from your passkey, on this phone. Our servers never see them.</p>
          </div>
          {exists === false ? (
            <Link href="/onboarding" className="block min-h-14 rounded-2xl bg-emerald-500 px-5 py-4 text-center text-lg font-semibold text-black">
              Create wallet
            </Link>
          ) : (
            <button
              disabled={exists === null}
              onClick={() => unlockWallet().catch((e) => toast.error(errText(e)))}
              className="min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
            >
              Unlock with passkey
            </button>
          )}
        </section>
        <Footer />
      </Page>
    );
  }

  let chainId: number | null = null;
  try {
    chainId = chain().chainId;
  } catch {
    chainId = null;
  }

  return (
    <Page>
      <section aria-label="Agent wallet balance">
        <p className="text-sm text-neutral-500">Agent wallet{chainId ? ` · chain ${chainId}` : ""}</p>
        <p className="mt-2 flex flex-wrap items-baseline gap-x-3">
          <span className="break-all text-[clamp(2.5rem,14vw,4rem)] font-semibold leading-tight tabular-nums tracking-tight">{bal ? bal.usdc : balErr ? "–" : "…"}</span>
          <span className="text-xl text-neutral-500">USDC</span>
        </p>
        <p className="mt-2 text-sm tabular-nums text-neutral-400">{bal ? bal.eth : "…"} ETH for gas</p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Link href="/pay" className="flex min-h-14 items-center justify-center rounded-2xl bg-emerald-500 text-lg font-semibold text-black">
            Pay
          </Link>
          <Link href="/receive" className="flex min-h-14 items-center justify-center rounded-2xl border border-neutral-800 text-lg font-semibold">
            Receive
          </Link>
        </div>
      </section>

      <RailgunCard wallet={wallet} onUpdated={refresh} />
      <PrivateBalances wallet={wallet} onSwept={refresh} />

      <TopUp address={wallet.address} onRefresh={refresh} />
      <Footer />
    </Page>
  );
}

function TopUp({ address, onRefresh }: { address: string; onRefresh: () => void }) {
  return (
    <section id="topup" className="border-t border-neutral-900 pt-6">
      <h2 className="text-base font-semibold">Top up</h2>
      <p className="mt-1 text-sm text-neutral-400">Send test USDC and a little ETH for gas. The balance is the most the agent can ever spend.</p>
      <div className="mt-5 flex justify-center">
        <AddressQr value={address} />
      </div>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(
            () => toast.info("Address copied"),
            () => toast.error("Couldn't copy"),
          );
        }}
        aria-label="Copy address"
        className="mt-4 min-h-12 w-full break-all rounded-xl border border-neutral-900 px-4 py-3 font-mono text-sm text-neutral-300"
      >
        {address}
      </button>
      <p className="mt-3 text-xs text-amber-300/80">
        Funding from your main wallet links the two on-chain. Use a faucet or a fresh wallet to keep them apart.
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <button onClick={onRefresh} className="min-h-12 rounded-xl border border-neutral-800">
          Refresh
        </button>
        <a href={addressUrl(address)} target="_blank" rel="noreferrer noopener" className="flex min-h-12 items-center justify-center rounded-xl border border-neutral-800">
          Explorer ↗
        </a>
        <button onClick={lockWallet} className="min-h-12 rounded-xl border border-neutral-800">
          Lock
        </button>
      </div>
    </section>
  );
}

function Footer() {
  return <p className="pb-4 text-center text-xs text-neutral-600">No analytics, no trackers, no CDN. Keys never leave this phone.</p>;
}
