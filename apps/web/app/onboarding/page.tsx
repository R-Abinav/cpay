"use client";
// Onboarding wizard: one step per screen (wallet -> World ID -> face -> funds), then an "All set" moment and into the app.
// Everything is made and kept on this phone; the only server call is the issuer's World ID check (no identity stored).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Card } from "@cpay/credential";
import { AddressQr } from "../../components/address-qr.js";
import { RestoreWallet } from "../../components/restore-wallet.js";
import { Address, CopyButton } from "../../components/ui.js";
import { FaceEnrol, useStoredTemplate } from "../../components/face-enrol.js";
import { useWallet } from "../../lib/hooks.js";
import { errText, toast } from "../../lib/toast.js";
import { VAULT, vaultDelete, vaultGet } from "../../lib/vault.js";
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

  // Back: on-screen button and the phone's back gesture both walk the steps (history entries per step).
  // Leaving a step that has work (World card, face template) asks: keep it, or discard it and go back.
  const [ask, setAsk] = useState(false);
  const passBack = useRef(false);
  const hasWork = (s: number) => (s === 1 && !!card) || (s === 2 && !!template);

  useEffect(() => {
    history.replaceState({ ...history.state, onb: 0 }, "");
  }, []);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const target = typeof e.state?.onb === "number" ? (e.state.onb as number) : 0;
      if (target >= step || done) return void setStep(Math.min(target, STEPS.length - 1));
      if (!passBack.current && hasWork(step)) {
        history.pushState({ ...history.state, onb: step }, ""); // stay until the user chooses
        setAsk(true);
        return;
      }
      passBack.current = false;
      setStep(target);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, card, template, done]);

  const next = () => {
    if (step >= STEPS.length - 1) return setDone(true);
    history.pushState({ ...history.state, onb: step + 1 }, "");
    setStep(step + 1);
  };
  const back = () => {
    if (step === 0) return router.push("/welcome");
    if (hasWork(step)) return setAsk(true);
    history.back();
  };
  async function leave(discard: boolean) {
    setAsk(false);
    if (discard) {
      try {
        if (step === 1) {
          await vaultDelete(VAULT.card);
          setCard(null);
        } else if (step === 2) await setTemplate(null);
      } catch (e) {
        return void toast.error(`Couldn't discard: ${errText(e)}`);
      }
    }
    passBack.current = true;
    history.back();
  }

  if (done) return <AllSet />;

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col px-5 pb-4 pt-2">
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

      {/* Sized to the screen: the page itself never scrolls. Only on very small phones does this area scroll. */}
      <div key={step} className="cpay-rise mt-[min(4dvh,2rem)] flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
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
                ✓ Wallet ready · <Address value={wallet.address} className="text-sm" label="wallet address" />
              </p>
            ) : (
              <div className="space-y-2">
              <button
                disabled={busy || exists === null}
                onClick={() => run(exists ? unlockWallet : createWallet)}
                className="min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
              >
                {busy ? "Waiting for passkey…" : exists ? "Unlock my wallet" : "Create wallet with passkey"}
              </button>
              {exists === false && <RestoreWallet to="/onboarding" />}
              </div>
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
                  <AddressQr value={wallet.address} size={180} />
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-neutral-800 px-4 py-3">
                  <span className="min-w-0 flex-1 break-all font-mono text-xs text-neutral-300">{wallet.address}</span>
                  <CopyButton value={wallet.address} label="wallet address" />
                </div>
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

      <footer className="mt-4 shrink-0 space-y-1">
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
      {ask && <LeaveSheet what={step === 1 ? "your World ID card" : "your face template"} onChoose={(d) => void leave(d)} onStay={() => setAsk(false)} />}
    </main>
  );
}

function LeaveSheet({ what, onChoose, onStay }: { what: string; onChoose: (discard: boolean) => void; onStay: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60" onClick={onStay} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        onClick={(e) => e.stopPropagation()}
        className="cpay-rise mx-auto w-full max-w-xl space-y-2 rounded-t-3xl border-t border-neutral-800 bg-neutral-950 p-5"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
      >
        <p id="leave-title" className="text-lg font-semibold">Go back?</p>
        <p className="pb-2 text-sm text-neutral-400">Keep {what} and edit the earlier step, or discard it and redo this step later.</p>
        <button onClick={() => onChoose(false)} className="min-h-12 w-full rounded-xl bg-white font-semibold text-black">
          Keep and go back
        </button>
        <button onClick={() => onChoose(true)} className="min-h-12 w-full rounded-xl border border-red-500/40 font-semibold text-red-300">
          Discard and go back
        </button>
        <button onClick={onStay} className="min-h-11 w-full text-sm text-neutral-500">
          Stay here
        </button>
      </div>
    </div>
  );
}

function Screen({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="space-y-[min(3dvh,1.5rem)]">
      <div>
        <h1 className="text-[clamp(1.6rem,4dvh,1.875rem)] font-semibold leading-tight tracking-tight">{title}</h1>
        <p className="mt-2 text-[clamp(0.875rem,2dvh,1rem)] text-neutral-400">{lead}</p>
      </div>
      {children}
    </section>
  );
}

function AllSet() {
  return (
    <main role="status" aria-live="polite" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-5 text-center">
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
