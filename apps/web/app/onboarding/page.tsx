"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Page } from "../../components/app-shell.js";
import { FaceEnrol, useStoredTemplate } from "../../components/face-enrol.js";
import type { Card } from "@cpay/credential";
import { useWallet } from "../../lib/hooks.js";
import { errText, toast } from "../../lib/toast.js";
import { VAULT, vaultGet } from "../../lib/vault.js";
import { CredentialStep } from "../receive/credential-step.js";
import { createWallet, hasWallet, prfSupported, unlockWallet } from "../../lib/wallet.js";

export default function OnboardingPage() {
  const wallet = useWallet();
  const [template, setTemplate] = useStoredTemplate();
  const [exists, setExists] = useState<boolean | null>(null);
  const [prf, setPrf] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<Card | null>(null);

  useEffect(() => {
    vaultGet<Card>(VAULT.card).then(setCard, () => setCard(null));
    hasWallet().then(setExists, () => setExists(false));
    prfSupported().then(setPrf, () => setPrf(false));
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Set up CPay</h1>
        <p className="mt-2 text-neutral-400">About a minute. Everything is made and kept on this phone.</p>
      </section>

      <section className="border-t border-neutral-900 pt-6">
        <h2 className="text-base font-semibold">1 · Your wallet, from a passkey</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Your phone makes a passkey. Every key (your agent wallet, your private receive keys) is derived from it, here on this phone. No
          account, no email, nothing stored on our servers. Synced passkeys are your backup.
        </p>
        {prf === false && (
          <p className="mt-3 text-sm text-amber-300">
            This browser can&apos;t derive keys from a passkey (no PRF). The wallet falls back to a random key kept on this phone only: if you
            lose the phone without a backup, the funds are lost.
          </p>
        )}
        {wallet ? (
          <p className="mt-4 text-emerald-300">
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
      </section>

      <section className={`border-t border-neutral-900 pt-6 ${wallet ? "" : "opacity-50"}`}>
        <h2 className="text-base font-semibold">2 · Fund your agent wallet</h2>
        <p className="mt-1 text-sm text-neutral-400">Test USDC + a little ETH for gas. The balance caps what the agent can spend.</p>
        <Link href="/#topup" className="mt-4 block min-h-12 rounded-xl border border-neutral-800 px-5 py-3 text-center font-semibold">
          Show top-up QR
        </Link>
      </section>

      <section className={`border-t border-neutral-900 pt-6 ${wallet ? "" : "opacity-50"}`}>
        <h2 className="text-base font-semibold">3 · Pair your glasses (optional)</h2>
        <p className="mt-1 text-sm text-neutral-400">Anyone can receive. To pay hands-free, pair your glasses with the code on their screen.</p>
        <Link href="/settings" className="mt-4 block min-h-12 rounded-xl border border-neutral-800 px-5 py-3 text-center font-semibold">
          Pair glasses
        </Link>
      </section>

      {/* 4 · World ID (Proof of Human): the card is blind-signed by the issuer and kept on this phone only. */}
      <CredentialStep card={card} onCard={setCard} enabled={!!wallet} step={4} lockedHint="Create or unlock your wallet first." />
      {card && (
        <Link href="/receive" className="block min-h-12 rounded-xl bg-emerald-500 px-5 py-3 text-center font-semibold text-black">
          Show my private CPay QR
        </Link>
      )}

      {template !== undefined && (
        <FaceEnrol template={template} onTemplate={(t) => void setTemplate(t)} step={5} title="Face pay (optional, stays on this phone)" />
      )}
    </Page>
  );
}
