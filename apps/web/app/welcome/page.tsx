"use client";
// Landing page for first-time visitors: particles, a short hero, swipeable cards on how CPay works (public vs private,
// World, 0G, keys), then "Try it out" -> the onboarding wizard. Exactly one screen tall. Same-origin only (CROPS).
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Particles } from "../../components/particles.js";
import { hasWallet } from "../../lib/wallet.js";

const CARDS: { tag: string; title: string; lines: string[] }[] = [
  {
    tag: "How you pay",
    title: "Look. Say it. Confirm.",
    lines: [
      "Look at a QR code or a person through the glasses and press Scan.",
      "Say “pay 2 USDC”. The glasses show a one-time code; say “confirm 47”.",
      "Your phone checks the code and signs. Voice feedback in your earbuds the whole way.",
    ],
  },
  {
    tag: "Public or private",
    title: "You choose who can see",
    lines: [
      "Public: your agent wallet pays. Simple, and visible on Etherscan.",
      "Private: paid from a Railgun shielded balance. A zero-knowledge proof is made on your phone, so the sender is hidden among Railgun users.",
      "Paying a CPay QR or a face? The recipient gets a fresh one-time address, never their main wallet.",
    ],
  },
  {
    tag: "World",
    title: "Real humans, no identities",
    lines: [
      "World ID: recipients prove they're a unique human. Payers learn only “a verified human”.",
      "The proof is an anonymous card kept on the recipient's phone, bound to each payment.",
      "World Agent Pass: over your spend limit, the agent stops and asks World that it's really you.",
    ],
  },
  {
    tag: "0G",
    title: "The agent's ears, brain and voice",
    lines: [
      "Speech-to-text, the payment intent and spoken amounts run on 0G in private mode.",
      "The AI only proposes an amount. It never holds keys, picks a recipient or decides.",
      "Every 0G call leaves a request ID and receipt you can check on the Evidence page.",
    ],
  },
  {
    tag: "Your keys",
    title: "Nothing worth stealing",
    lines: [
      "Every key is made from your passkey, on your phone. No account, no email.",
      "Our servers never hold your keys, money, face or payment history.",
      "No analytics, no trackers, no CDN. Camera and mic only when you ask.",
    ],
  },
];

export default function WelcomePage() {
  const [hasW, setHasW] = useState(false);
  const [i, setI] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const touched = useRef(false);

  useEffect(() => {
    hasWallet().then(setHasW, () => setHasW(false));
  }, []);

  // Gentle auto-advance until the user swipes.
  useEffect(() => {
    const t = setInterval(() => {
      if (touched.current || !strip.current) return;
      const next = (i + 1) % CARDS.length;
      strip.current.scrollTo({ left: next * strip.current.clientWidth, behavior: "smooth" });
    }, 6000);
    return () => clearInterval(t);
  }, [i]);

  const onScroll = () => {
    const el = strip.current;
    if (el) setI(Math.round(el.scrollLeft / el.clientWidth));
  };
  const go = (n: number) => {
    touched.current = true;
    strip.current?.scrollTo({ left: n * strip.current.clientWidth, behavior: "smooth" });
  };

  return (
    <main className="relative mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col overflow-hidden pb-5 pt-[min(5dvh,2.5rem)]">
      <Particles />

      <section className="relative px-5">
        <p className="cpay-rise text-sm font-semibold tracking-widest text-emerald-400">CPAY</p>
        <h1
          className="cpay-rise mt-[min(1.5dvh,0.75rem)] text-[clamp(1.9rem,min(10vw,5.5dvh),3rem)] font-semibold leading-[1.05] tracking-tight"
          style={{ animationDelay: "80ms" }}
        >
          Pay by looking.
          <br />
          <span className="text-neutral-500">Keep it private.</span>
        </h1>
        <p className="cpay-rise mt-[min(1.5dvh,0.75rem)] text-[clamp(0.9rem,2.1dvh,1.05rem)] text-neutral-300" style={{ animationDelay: "160ms" }}>
          A privacy-first wallet with hands-free glasses. Anyone can receive; pair glasses to pay with your voice.
        </p>
      </section>

      <section className="cpay-rise relative mt-[min(3dvh,1.5rem)] flex min-h-0 flex-1 flex-col" style={{ animationDelay: "260ms" }} aria-label="How CPay works">
        <div
          ref={strip}
          onScroll={onScroll}
          onTouchStart={() => (touched.current = true)}
          className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {CARDS.map((c) => (
            <article key={c.tag} className="w-full shrink-0 snap-center px-5">
              <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-neutral-800/80 bg-neutral-950/70 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">{c.tag}</p>
                <h2 className="mt-2 text-[clamp(1.1rem,2.8dvh,1.35rem)] font-semibold leading-snug">{c.title}</h2>
                <ul className="mt-3 space-y-[min(1.4dvh,0.75rem)]">
                  {c.lines.map((l) => (
                    <li key={l} className="flex gap-2.5 text-[clamp(0.8rem,1.9dvh,0.9rem)] leading-snug text-neutral-300">
                      <span aria-hidden className="mt-[0.45em] h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400/80" />
                      {l}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
        <div className="mt-3 flex justify-center gap-1.5" role="tablist" aria-label="Cards">
          {CARDS.map((c, n) => (
            <button
              key={c.tag}
              role="tab"
              aria-selected={n === i}
              aria-label={c.tag}
              onClick={() => go(n)}
              className="grid h-6 place-items-center px-0.5"
            >
              <span className={`block h-1.5 rounded-full transition-all duration-300 ${n === i ? "w-6 bg-emerald-400" : "w-1.5 bg-neutral-700"}`} />
            </button>
          ))}
        </div>
      </section>

      <div className="cpay-rise relative mt-3 space-y-2 px-5" style={{ animationDelay: "380ms" }}>
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
    </main>
  );
}
