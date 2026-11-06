"use client";
// Landing page for first-time visitors: what CPay is, why it's private, then "Try it out" -> the onboarding wizard.
// Static, same-origin only: no trackers, fonts or images from anywhere else (CROPS).
import Link from "next/link";
import { useEffect, useState } from "react";
import { hasWallet } from "../../lib/wallet.js";

const FEATURES = [
  {
    title: "Look, say, paid",
    body: "Look at a QR code or a person, say “pay 2 USDC”, then say the code on your glasses. Your phone stays in your pocket.",
  },
  {
    title: "Keys never leave your phone",
    body: "Your wallet is made from a passkey, on this phone. No account, no email. Our servers never hold your keys or money.",
  },
  {
    title: "A verified human, not an identity",
    body: "World ID proves the person you pay is a unique human, without revealing who they are. Each payment goes to a fresh one-time address.",
  },
  {
    title: "Private by default",
    body: "The camera and mic run only when you ask. Faces become numbers on the phone and are never uploaded. No analytics, no trackers.",
  },
];

export default function WelcomePage() {
  const [hasW, setHasW] = useState(false);
  useEffect(() => {
    hasWallet().then(setHasW, () => setHasW(false));
  }, []);

  return (
    <main className="relative mx-auto flex min-h-screen max-w-xl flex-col overflow-hidden px-5 pb-10 pt-12">
      <div
        aria-hidden
        className="cpay-glow pointer-events-none absolute -top-32 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-emerald-500/30 blur-3xl"
      />

      <section className="relative">
        <p className="cpay-rise text-sm font-semibold tracking-widest text-emerald-400">CPAY</p>
        <h1 className="cpay-rise mt-4 text-[clamp(2.4rem,11vw,3.5rem)] font-semibold leading-[1.05] tracking-tight" style={{ animationDelay: "80ms" }}>
          Pay by looking.
          <br />
          <span className="text-neutral-500">Keep it private.</span>
        </h1>
        <p className="cpay-rise mt-5 text-lg text-neutral-300" style={{ animationDelay: "160ms" }}>
          A privacy-first wallet with hands-free glasses. Anyone can receive. Pair glasses to pay with your voice.
        </p>
        <div className="cpay-rise mt-8 space-y-3" style={{ animationDelay: "240ms" }}>
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
          <p className="text-center text-xs text-neutral-500">About a minute · testnet only (Ethereum Sepolia)</p>
        </div>
      </section>

      <section className="relative mt-14 space-y-3">
        {FEATURES.map((f, i) => (
          <div
            key={f.title}
            className="cpay-rise rounded-2xl border border-neutral-900 bg-neutral-900/40 p-4"
            style={{ animationDelay: `${360 + i * 90}ms` }}
          >
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-1 text-sm text-neutral-400">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="cpay-rise relative mt-12" style={{ animationDelay: "760ms" }}>
        <h2 className="text-sm font-semibold text-neutral-400">How it works</h2>
        <ol className="mt-3 space-y-2 text-sm text-neutral-300">
          <li>1 · Create a passkey wallet on this phone</li>
          <li>2 · Prove you&apos;re a unique human with World ID</li>
          <li>3 · Optionally add face pay (stays on this phone)</li>
          <li>4 · Add test funds, pair your glasses, and pay hands-free</li>
        </ol>
        <Link
          href="/onboarding"
          className="mt-8 flex min-h-14 items-center justify-center rounded-2xl bg-emerald-500 text-lg font-semibold text-black transition-transform active:scale-[0.98]"
        >
          Get started
        </Link>
        <p className="mt-6 text-center text-xs text-neutral-600">No analytics, no trackers, no CDN. Built at ETHGlobal Mumbai.</p>
      </section>
    </main>
  );
}
