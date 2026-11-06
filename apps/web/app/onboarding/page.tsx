"use client";
// Onboarding wizard: one step per screen (wallet -> World ID -> face -> funds), then an "All set" moment and into the app.
// Everything is made and kept on this phone; the only server call is the issuer's World ID check (no identity stored).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { Card } from "@cpay/credential";
import { AddressQr } from "../../components/address-qr.js";
import { FaceEnrol, useStoredTemplate } from "../../components/face-enrol.js";
import { useWallet } from "../../lib/hooks.js";
import { errText, toast } from "../../lib/toast.js";
import { VAULT, vaultGet } from "../../lib/vault.js";
import { CredentialStep } from "../receive/credential-step.js";
import { createWallet, hasWallet, prfSupported, unlockWallet } from "../../lib/wallet.js";

const STEPS = ["Wallet", "World ID", "Face pay", "Funds"] as const;
const ALL_SET_MS = 1800;

export default function OnboardingPage() {
  const router = useRouter();
  const wallet = useWallet();
  const [template, setTemplate] = useStoredTemplate();
  const [exists, setExists] = useState<boolean | null>(null);
  const [prf, setPrf] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<Card | null>(null);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    vaultGet<Card>(VAULT.card).then(setCard, () => setCard(null));
    hasWallet().then(setExists, () => setExists(false));
    prfSupported().then(setPrf, () => setPrf(false));
  }, []);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => router.replace("/"), ALL_SET_MS);
    return () => clearTimeout(t);
  }, [done, router]);

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

  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : setDone(true));
  const back = () => (step > 0 ? setStep(step - 1) : router.push("/welcome"));

  if (done) return <AllSet />;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col px-5 pb-8 pt-4">
      <header className="flex items-center justify-between">
        <button type="button" onClick={back} className="min-h-11 pr-4 text-sm text-neutral-400 hover:text-neutral-100" aria-label="Back">
          ← Back
        </button>
        <span className="text-xs text-neutral-500">
          Step {step + 1} of {STEPS.length}
        </span>
      </header>
      <div className="mt-3 grid grid-cols-4 gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span key={s} className={`h-1 rounded-full transition-colors duration-500 ${i <= step ? "bg-emerald-500" : "bg-neutral-800"}`} />
        ))}
      </div>

      <div key={step} className="cpay-rise mt-8 flex flex-1 flex-col">
        {step === 0 && (
          <Screen title="Your wallet, from a passkey" lead="Every key is made from a passkey, here on this phone. No account, no email, nothing on our servers. Synced passkeys are your backup.">
            {prf === false && (
              <p className="text-sm text-amber-300">
                This browser can&apos;t derive keys from a passkey (no PRF). The wallet falls back to a random key kept on this phone only: if you
                lose the phone, the funds are lost.
              </p>
            )}
            {wallet ? (
              <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-emerald-300">
                ✓ Wallet ready · <span className="font-mono text-sm">{wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}</span>
              </p>
            ) : (
              <button
                disabled={busy || exists === null}
                onClick={() => run(exists ? unlockWallet : createWallet)}
                className="min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
              >
                {busy ? "Waiting for passkey…" : exists ? "Unlock my wallet" : "Create wallet with passkey"}
              </button>
            )}
          </Screen>
        )}

        {step === 1 && (
          <Screen title="Prove you're a unique human" lead="World ID shows payers “a verified human”, never who you are. Your card is kept on this phone only.">
            <CredentialStep card={card} onCard={setCard} enabled={!!wallet} bare lockedHint="Go back and create or unlock your wallet first." />
          </Screen>
        )}

        {step === 2 && (
          <Screen title="Face pay (optional)" lead="Lets someone wearing CPay glasses pay you by looking at you. Your face becomes 128 numbers, kept encrypted on this phone.">
            {template !== undefined && <FaceEnrol template={template} onTemplate={(t) => void setTemplate(t)} bare />}
          </Screen>
        )}

        {step === 3 && (
          <Screen title="Add test funds" lead="Send test USDC and a little Sepolia ETH for gas to your agent wallet. The balance caps what the agent can ever spend.">
            {wallet ? (
              <div className="space-y-3">
                <div className="flex justify-center">
                  <AddressQr value={wallet.address} size={200} />
                </div>
                <button
                  onClick={() =>
                    void navigator.clipboard?.writeText(wallet.address).then(
                      () => toast.info("Address copied"),
                      () => toast.error("Couldn't copy"),
                    )
                  }
                  className="min-h-12 w-full break-all rounded-xl border border-neutral-800 px-4 py-3 font-mono text-xs text-neutral-300"
                >
                  {wallet.address}
                </button>
                <p className="text-xs text-amber-300/80">Funding from your main wallet links the two on-chain. Use a faucet or a fresh wallet.</p>
                <p className="text-xs text-neutral-500">
                  Have CPay glasses? Pair them later in{" "}
                  <Link href="/settings" className="underline">
                    Settings
                  </Link>
                  .
                </p>
              </div>
            ) : (
              <p className="text-sm text-neutral-400">Create your wallet first (step 1).</p>
            )}
          </Screen>
        )}
      </div>

      <footer className="mt-8 space-y-2">
        <button
          type="button"
          onClick={next}
          disabled={step === 0 && !wallet}
          className="min-h-14 w-full rounded-2xl bg-white px-5 text-lg font-semibold text-black transition-transform active:scale-[0.98] disabled:opacity-30"
        >
          {step === STEPS.length - 1 ? "Finish" : "Continue"}
        </button>
        {(step === 1 && !card) || (step === 2 && !template) ? (
          <button type="button" onClick={next} className="min-h-11 w-full text-sm text-neutral-500 hover:text-neutral-300">
            Skip for now
          </button>
        ) : null}
      </footer>
    </main>
  );
}

function Screen({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold leading-tight tracking-tight">{title}</h1>
        <p className="mt-3 text-neutral-400">{lead}</p>
      </div>
      {children}
    </section>
  );
}

function AllSet() {
  return (
    <main role="status" aria-live="polite" className="flex min-h-screen flex-col items-center justify-center gap-6 px-5 text-center">
      <div className="cpay-pop grid h-28 w-28 place-items-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/40">
        <svg viewBox="0 0 48 48" className="h-14 w-14 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path className="cpay-draw" d="M12 25l8 8 16-17" />
        </svg>
      </div>
      <div className="cpay-rise" style={{ animationDelay: "300ms" }}>
        <p className="text-3xl font-semibold tracking-tight">All set</p>
        <p className="mt-2 text-neutral-400">Taking you to your wallet…</p>
      </div>
    </main>
  );
}
