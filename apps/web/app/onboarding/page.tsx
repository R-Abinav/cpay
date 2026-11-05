"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "../../lib/hooks.js";
import { createWallet, hasWallet, prfSupported, unlockWallet } from "../../lib/wallet.js";

export default function OnboardingPage() {
  const wallet = useWallet();
  const [exists, setExists] = useState<boolean | null>(null);
  const [prf, setPrf] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    hasWallet().then(setExists, () => setExists(false));
    prfSupported().then(setPrf, () => setPrf(false));
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">Set up CPay</h1>

      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
        <h2 className="text-lg font-semibold">1 · Your wallet, from a passkey</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Your phone makes a passkey. Every key (your agent wallet, your private receive keys) is derived from it, here on this phone. No
          account, no email, nothing stored on our servers. Synced passkeys are your backup.
        </p>
        {prf === false && (
          <p className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            This browser can&apos;t derive keys from a passkey (no PRF). The wallet falls back to a random key kept on this phone only: if you
            lose the phone without a backup, the funds are lost.
          </p>
        )}
        {wallet ? (
          <p className="mt-4 rounded-xl bg-emerald-500/10 p-3 text-emerald-300">
            Wallet ready: <span className="font-mono text-sm">{wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}</span>
          </p>
        ) : exists ? (
          <button
            disabled={busy}
            onClick={() => run(unlockWallet)}
            className="mt-4 min-h-14 w-full rounded-xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
          >
            {busy ? "Waiting for passkey…" : "Unlock existing wallet"}
          </button>
        ) : (
          <button
            disabled={busy || exists === null}
            onClick={() => run(createWallet)}
            className="mt-4 min-h-14 w-full rounded-xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
          >
            {busy ? "Waiting for passkey…" : "Create wallet"}
          </button>
        )}
        {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
      </section>

      <section className={`rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 ${wallet ? "" : "opacity-50"}`}>
        <h2 className="text-lg font-semibold">2 · Fund your agent wallet</h2>
        <p className="mt-1 text-sm text-neutral-400">Base Sepolia USDC + a little ETH for gas. The balance caps what the agent can spend.</p>
        <Link href="/" className="mt-4 block rounded-xl bg-neutral-800 px-5 py-4 text-center font-semibold">
          Show top-up QR
        </Link>
      </section>

      <section className={`rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 ${wallet ? "" : "opacity-50"}`}>
        <h2 className="text-lg font-semibold">3 · Pair your glasses (optional)</h2>
        <p className="mt-1 text-sm text-neutral-400">Anyone can receive. To pay hands-free, pair your glasses with the code on their screen.</p>
        <Link href="/settings" className="mt-4 block rounded-xl bg-neutral-800 px-5 py-4 text-center font-semibold">
          Pair glasses
        </Link>
      </section>

      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
        <h2 className="text-lg font-semibold">4 · Receive privately (World ID)</h2>
        <p className="mt-1 text-sm text-neutral-400">Prove you&apos;re a unique human without revealing who you are, then show your private CPay QR.</p>
        <Link href="/receive" className="mt-4 block rounded-xl bg-neutral-800 px-5 py-4 text-center font-semibold">
          Go to Receive
        </Link>
      </section>
    </main>
  );
}
