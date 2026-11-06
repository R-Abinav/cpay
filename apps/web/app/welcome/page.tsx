"use client";
// Landing page for first-time visitors: what CPay is, why it's private, then "Try it out" -> the onboarding wizard.
// Static, same-origin only: no trackers, fonts or images from anywhere else (CROPS).
import Link from "next/link";
import { useEffect, useState } from "react";
import { hasWallet } from "../../lib/wallet.js";

const FEATURES = [
  { title: "Look, say, paid", body: "Look at a QR or a person, say the amount, confirm by voice." },
  { title: "Keys never leave your phone", body: "Made from a passkey. No account, no email." },
  { title: "Verified human, not an identity", body: "World ID proves a unique human; each payment hits a fresh address." },
  { title: "Private by default", body: "Camera and mic only when you ask. No trackers." },
];

export default function WelcomePage() {
  const [hasW, setHasW] = useState(false);
  useEffect(() => {
    hasWallet().then(setHasW, () => setHasW(false));
  }, []);

  return (
    <main className="relative mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col overflow-hidden px-5 pb-5 pt-[min(6dvh,3rem)]">
      <div
        aria-hidden
        className="cpay-glow pointer-events-none absolute -top-32 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-emerald-500/30 blur-3xl"
      />

      <section className="relative">
        <p className="cpay-rise text-sm font-semibold tracking-widest text-emerald-400">CPAY</p>
        <h1
          className="cpay-rise mt-[min(2dvh,1rem)] text-[clamp(2rem,min(10vw,6dvh),3.25rem)] font-semibold leading-[1.05] tracking-tight"
          style={{ animationDelay: "80ms" }}
        >
          Pay by looking.
          <br />
          <span className="text-neutral-500">Keep it private.</span>
        </h1>
        <p className="cpay-rise mt-[min(2dvh,1rem)] text-[clamp(0.95rem,2.2dvh,1.125rem)] text-neutral-300" style={{ animationDelay: "160ms" }}>
          A privacy-first wallet with hands-free glasses. Anyone can receive. Pair glasses to pay with your voice.
        </p>
      </section>

      <ul className="relative mt-[min(4dvh,2rem)] flex min-h-0 flex-1 flex-col justify-center gap-[min(1.6dvh,0.75rem)]">
        {FEATURES.map((f, i) => (
          <li key={f.title} className="cpay-rise flex gap-3" style={{ animationDelay: `${240 + i * 80}ms` }}>
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <div>
              <p className="text-[clamp(0.9rem,2dvh,1rem)] font-semibold leading-snug">{f.title}</p>
              <p className="text-[clamp(0.8rem,1.8dvh,0.875rem)] leading-snug text-neutral-400">{f.body}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="cpay-rise relative mt-4 space-y-2" style={{ animationDelay: "600ms" }}>
        <Link
          href="/onboarding"
          className="flex min-h-14 items-center justify-center rounded-2xl bg-emerald-500 text-lg font-semibold text-black transition-transform active:scale-[0.98]"
        >
          Try it out
        </Link>
        {hasW && (
          <Link href="/" className="flex min-h-12 items-center justify-center rounded-2xl border border-neutral-800 font-semibold">
            Open my wallet
          </Link>
        )}
        <p className="text-center text-xs text-neutral-500">About a minute · testnet only · no analytics, no trackers</p>
      </div>
    </main>
  );
}
