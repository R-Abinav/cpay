"use client";
// Wallet tab: the balance card (public USDC big, private Railgun balance under it), Pay / Receive / Withdraw, the setup
// checklist, then the private balance controls, money received on one-time addresses, and top-up.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AddressQr } from "../components/address-qr.js";
import { Page } from "../components/app-shell.js";
import { PrivateBalances } from "../components/private-balances.js";
import { RailgunBalance } from "../components/railgun-balance.js";
import { SetupChecklist } from "../components/setup-checklist.js";
import { useWallet } from "../lib/hooks.js";
import { railgunStore } from "../lib/railgun.js";
import { errText, toast } from "../lib/toast.js";
import { addressUrl, fmtUnits, getBalances, hasWallet, lockWallet, unlockWallet } from "../lib/wallet.js";
import { UnlockButton } from "../components/unlock-button.js";
import { Withdraw } from "../components/withdraw.js";
import { isStandalone, RestoreWallet } from "../components/restore-wallet.js";
import { Address, CopyButton } from "../components/ui.js";

export default function WalletPage() {
  const wallet = useWallet();
  const [exists, setExists] = useState<boolean | null>(null);
  const [bal, setBal] = useState<{ eth: string; usdc: string } | null>(null);
  const [balErr, setBalErr] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const router = useRouter();

  // First visit (no wallet on this phone): the landing page, which leads into onboarding.
  useEffect(() => {
    if (exists === false && !wallet) router.replace("/welcome");
  }, [exists, wallet, router]);

  // Installed app reopened with a stored (locked) wallet: ask for the passkey once, straight away, so the user lands
  // on their balance. A cancel or a browser that needs a tap just leaves the Unlock button.
  useEffect(() => {
    if (exists !== true || wallet || !isStandalone()) return;
    try {
      if (sessionStorage.getItem("cpay.autoUnlockTried")) return;
      sessionStorage.setItem("cpay.autoUnlockTried", "1");
    } catch {
      return;
    }
    void unlockWallet().catch(() => undefined);
  }, [exists, wallet]);

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
        <section className="flex min-h-[60vh] flex-col justify-center gap-8">
          <div>
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/30" aria-hidden>
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
                <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" strokeLinecap="round" />
              </svg>
            </span>
            <p className="mt-5 text-3xl font-semibold tracking-tight">{exists === false ? "No wallet on this phone yet" : "Wallet locked"}</p>
            <p className="mt-2 text-neutral-400">Your keys come from your passkey, on this phone.</p>
          </div>
          {exists === false ? (
            <div className="space-y-2">
              <Link href="/onboarding" className="block min-h-14 rounded-2xl bg-emerald-500 px-5 py-4 text-center text-lg font-semibold text-black">
                Create wallet
              </Link>
              <RestoreWallet />
            </div>
          ) : (
            <UnlockButton disabled={exists === null} />
          )}
        </section>
        <Footer />
      </Page>
    );
  }

  const funded = bal ? Number(bal.usdc) > 0 : balErr ? false : null;

  return (
    <Page>
      <section aria-label="Balance" className="space-y-4">
        <BalanceCard bal={bal} balErr={balErr} address={wallet.address} onRefresh={refresh} />
        <div className="grid grid-cols-3 gap-2.5">
          <Link href="/pay" className="flex min-h-14 items-center justify-center rounded-2xl bg-emerald-500 text-base font-semibold text-black hover:bg-emerald-400">
            Pay
          </Link>
          <Link href="/receive" className="flex min-h-14 items-center justify-center rounded-2xl border border-neutral-800 text-base font-semibold hover:bg-neutral-900">
            Receive
          </Link>
          <button onClick={() => setWithdraw(true)} className="flex min-h-14 items-center justify-center rounded-2xl border border-neutral-800 text-base font-semibold hover:bg-neutral-900">
            Withdraw
          </button>
        </div>
        {withdraw && <Withdraw wallet={wallet} balances={bal} onDone={refresh} onClose={() => setWithdraw(false)} />}
      </section>

      <SetupChecklist funded={funded} />

      <RailgunBalance wallet={wallet} onDeposited={refresh} />

      <PrivateBalances wallet={wallet} onSwept={refresh} />

      <TopUp address={wallet.address} />
      <Footer />
    </Page>
  );
}

/** Public agent-wallet USDC big; the private Railgun balance (if loaded) as a quieter second line in the same card. */
function BalanceCard({
  bal,
  balErr,
  address,
  onRefresh,
}: {
  bal: { eth: string; usdc: string } | null;
  balErr: boolean;
  address: string;
  onRefresh: () => void;
}) {
  const rg = useSyncExternalStore(railgunStore.subscribe, railgunStore.get, railgunStore.get);
  const priv = rg.balances ? fmtUnits(rg.balances.usdc.valid, 6) : rg.syncing || rg.status === "loading" ? "…" : null;
  return (
    <div className="rounded-3xl border border-neutral-800 bg-gradient-to-b from-neutral-900/60 to-neutral-950 p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-neutral-400">Agent wallet</p>
        <div className="flex items-center gap-1">
          <button onClick={onRefresh} aria-label="Refresh balance" title="Refresh" className="grid h-9 w-9 place-items-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 5v6h-6" />
            </svg>
          </button>
          <button onClick={lockWallet} className="min-h-9 rounded-full px-3 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100">
            Lock
          </button>
        </div>
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="break-all text-[clamp(2.5rem,13vw,3.75rem)] font-semibold leading-tight tabular-nums tracking-tight">{bal ? bal.usdc : balErr ? "–" : "…"}</span>
        <span className="text-lg text-neutral-500">USDC</span>
      </p>
      <p className="mt-1 text-sm tabular-nums text-neutral-500">{bal ? bal.eth : "…"} ETH for gas</p>
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-neutral-800/80 pt-4">
        <span className="inline-flex items-center gap-2 text-sm text-neutral-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
          Private
        </span>
        <span className="text-sm tabular-nums text-neutral-200">
          {priv === null ? (
            <a href="#private" className="text-neutral-500 underline-offset-2 hover:underline">
              not loaded
            </a>
          ) : (
            <>
              {priv} <span className="text-neutral-500">USDC</span>
            </>
          )}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-sm text-neutral-500">
        <Address value={address} label="wallet address" />
        <a href={addressUrl(address)} target="_blank" rel="noreferrer noopener" className="min-h-9 py-2 hover:text-neutral-200">
          Etherscan ↗
        </a>
      </div>
    </div>
  );
}

function TopUp({ address }: { address: string }) {
  return (
    <section id="topup" className="border-t border-neutral-900 pt-6">
      <h2 className="text-base font-semibold">Top up</h2>
      <p className="mt-1 text-sm text-neutral-400">Send test USDC and a little ETH for gas to this address.</p>
      <div className="mt-5 flex justify-center">
        <AddressQr value={address} />
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-neutral-900 px-4 py-3">
        <span className="min-w-0 flex-1 break-all font-mono text-sm text-neutral-300">{address}</span>
        <CopyButton value={address} label="wallet address" />
      </div>
      <p className="mt-3 text-xs text-amber-300/80">Funding from your main wallet links the two on-chain. Use a faucet or a fresh wallet.</p>
    </section>
  );
}

function Footer() {
  return <p className="pb-4 text-center text-xs text-neutral-600">No analytics, no trackers. Keys never leave this phone.</p>;
}
