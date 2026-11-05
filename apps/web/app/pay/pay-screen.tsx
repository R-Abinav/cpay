"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { GlassesPill } from "../../components/app-shell.js";
import { getHub } from "../../lib/hub-client.js";
import { useHubStatus, useWallet } from "../../lib/hooks.js";
import { isActive, type PayState } from "../../lib/pay-machine.js";
import { currentWallet, hasWallet, txUrl, unlockWallet } from "../../lib/wallet.js";
import { PayController } from "./controller.js";

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function headline(st: PayState): { title: string; sub?: string; tone: "idle" | "busy" | "good" | "bad" | "warn" } {
  switch (st.s) {
    case "IDLE":
      return { title: "Ready", sub: "Look at a wallet QR, then tap Scan.", tone: "idle" };
    case "SCANNING":
      return { title: "Scanning…", sub: "Camera on until a QR is read (max 10 s).", tone: "busy" };
    case "NO_QR":
      return {
        title: st.why === "wrong_network" ? "Wrong network" : st.why === "not_wallet" ? "Not a wallet QR" : "No QR found",
        sub: "Tap Scan to retry.",
        tone: "warn",
      };
    case "QR_LOCKED":
      return { title: "QR locked", tone: "busy" };
    case "CPAY_PENDING":
      return { title: "CPay QR: private pay coming next", sub: "Verified-human private payments aren't wired in this build. Nothing was paid.", tone: "warn" };
    case "LISTENING_AMOUNT":
      return { title: st.tries > 1 ? "Say the amount again" : "Say the amount", sub: "e.g. “pay 2 USDC”", tone: "busy" };
    case "THINKING":
      return { title: "Understanding…", sub: "0G private mode", tone: "busy" };
    case "POLICY":
      return { title: `${st.intent.amount} ${st.intent.token}`, sub: "Checking your limits…", tone: "busy" };
    case "NEEDS_APPROVAL":
      return { title: "Approve on phone", sub: `Over your limit (${st.reason}).`, tone: "warn" };
    case "CONFIRMING":
      return st.phase === "tap"
        ? { title: "Tap Confirm to pay", sub: "Voice confirm didn't match twice.", tone: "warn" }
        : { title: `Pay ${st.intent.amount} ${st.intent.token}?`, sub: "Say “confirm” + the code on your glasses.", tone: "busy" };
    case "PAYING":
      return { title: "Paying…", sub: "Signed on this phone.", tone: "busy" };
    case "PAID":
      return { title: `Paid ${st.intent.amount} ${st.intent.token}`, tone: "good" };
    case "CANCELLED":
      return { title: "Cancelled", sub: `${st.reason}. Nothing was paid.`, tone: "bad" };
    case "BRAIN_OFFLINE":
      return { title: "BRAIN OFFLINE · PAUSED", sub: "0G is unreachable. Nothing happens until it's back.", tone: "bad" };
    case "FAILED":
      return { title: "Stopped", sub: st.reason, tone: "bad" };
  }
}

const TONE = {
  idle: "border-neutral-700 bg-neutral-900",
  busy: "border-sky-500/50 bg-sky-950/40",
  good: "border-emerald-500/60 bg-emerald-950/40",
  bad: "border-red-500/60 bg-red-950/40",
  warn: "border-amber-500/60 bg-amber-950/30",
} as const;

export function PayScreen() {
  const hub = useHubStatus();
  const wallet = useWallet();
  const ctrl = useMemo(() => new PayController(getHub(), currentWallet), []);
  useEffect(() => () => ctrl.dispose(), [ctrl]);
  const view = useSyncExternalStore(ctrl.subscribe, ctrl.getView, ctrl.getView);
  const st = view.state;
  const active = isActive(st);

  const [exists, setExists] = useState<boolean | null>(null);
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  useEffect(() => {
    hasWallet().then(setExists, () => setExists(false));
  }, []);

  // Glasses dropped mid-session: stop the camera/mic path (a payment being sent still finishes).
  useEffect(() => {
    if (!hub.online && active) ctrl.stop();
  }, [hub.online, active, ctrl]);

  const h = headline(st);

  if (!wallet) {
    return (
      <Shell>
        <Card>
          <p className="text-lg font-semibold">Wallet locked</p>
          {exists === false ? (
            <Link href="/onboarding" className="mt-4 block rounded-xl bg-emerald-500 px-5 py-4 text-center font-semibold text-black">
              Create your wallet
            </Link>
          ) : (
            <button
              className="mt-4 min-h-14 w-full rounded-xl bg-emerald-500 px-5 font-semibold text-black"
              onClick={() => {
                setUnlockErr(null);
                unlockWallet().catch((e) => setUnlockErr(e instanceof Error ? e.message : String(e)));
              }}
            >
              Unlock with passkey
            </button>
          )}
          {unlockErr && <p className="mt-3 text-sm text-red-300">{unlockErr}</p>}
        </Card>
      </Shell>
    );
  }

  if (hub.conn !== "connected" || !hub.online) {
    return (
      <Shell>
        <Card>
          <p className="text-xl font-semibold">Glasses disconnected · receive only</p>
          <p className="mt-2 text-sm text-neutral-400">
            Pay unlocks while your paired glasses are online.{" "}
            {hub.conn === "unpaired" || hub.conn === "no_hub" ? "Pair them in Settings." : "Waiting for them to connect…"}
          </p>
          <div className="mt-4 flex gap-3">
            <Link href="/settings" className="flex-1 rounded-xl bg-neutral-800 px-4 py-3 text-center font-semibold">
              Settings
            </Link>
            <Link href="/receive" className="flex-1 rounded-xl bg-neutral-800 px-4 py-3 text-center font-semibold">
              Receive
            </Link>
          </div>
        </Card>
        {view.log.length > 0 && <ScanLog view={view} />}
      </Shell>
    );
  }

  return (
    <Shell>
      <section className={`rounded-2xl border p-5 ${TONE[h.tone]}`} aria-live="polite">
        <p className="text-2xl font-bold">{h.title}</p>
        {h.sub && <p className="mt-1 text-neutral-300">{h.sub}</p>}
        {"recipient" in st && st.recipient.kind === "address" && (
          <p className="mt-3 text-sm text-neutral-300">
            To <span className="font-mono">{short(st.recipient.address)}</span>{" "}
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-200">public address · not verified</span>
          </p>
        )}
        {view.micOn && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-red-600/20 px-3 py-1 text-sm text-red-200">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden /> Microphone on
          </p>
        )}
      </section>

      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-neutral-800 bg-black">
        {view.feedUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={view.feedUrl} alt="Glasses camera (live, not stored)" className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center text-sm text-neutral-500">Camera off</div>
        )}
        {view.feedUrl && (
          <span className="absolute left-2 top-2 rounded bg-red-600 px-2 py-0.5 text-xs font-semibold">LIVE · {view.stats.fps} fps</span>
        )}
      </div>

      {st.s === "CONFIRMING" && st.phase === "tap" && (
        <button
          onClick={() => ctrl.confirmTap()}
          className="min-h-20 w-full rounded-2xl bg-emerald-500 text-2xl font-bold text-black"
        >
          Confirm {st.intent.amount} {st.intent.token}
        </button>
      )}

      {st.s === "NEEDS_APPROVAL" && (
        <Card>
          <p className="font-semibold">World Agent Pass: not connected</p>
          <p className="mt-1 text-sm text-neutral-400">
            Over-cap approval on the phone isn&apos;t wired into this build yet, so this payment can&apos;t go through. Nothing was paid. Lower
            the amount or raise your caps in Settings.
          </p>
        </Card>
      )}

      {st.s === "PAID" && (
        <a
          href={txUrl(st.txHash)}
          target="_blank"
          rel="noreferrer noopener"
          className="block rounded-xl border border-emerald-500/50 px-4 py-3 text-center text-emerald-300 underline"
        >
          View on BaseScan ↗
        </a>
      )}

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => ctrl.startScan()}
          disabled={active}
          className="min-h-20 rounded-2xl bg-emerald-500 text-2xl font-bold text-black disabled:opacity-30"
        >
          Scan
        </button>
        <button
          onClick={() => ctrl.stop()}
          disabled={!active && !view.feedUrl}
          className="min-h-20 rounded-2xl bg-red-600 text-2xl font-bold text-white disabled:opacity-30"
        >
          Stop
        </button>
      </div>

      <ScanLog view={view} />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Pay</h1>
        <GlassesPill />
      </header>
      {children}
    </main>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">{children}</section>;
}

function ScanLog({ view }: { view: ReturnType<PayController["getView"]> }) {
  return (
    <details className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
      <summary className="cursor-pointer select-none font-semibold">
        Scan log · {view.stats.frames} frames · {view.stats.drops} drops · {view.stats.fps} fps
      </summary>
      <p className="mt-2 text-xs text-neutral-500">No image data, transcripts or full addresses are ever logged.</p>
      <ol className="mt-2 max-h-80 space-y-1 overflow-y-auto font-mono text-xs text-neutral-300">
        {view.log.map((l, i) => (
          <li key={i}>
            <span className="text-neutral-500">{l.ts}</span>{" "}
            {l.href ? (
              <a href={l.href} target="_blank" rel="noreferrer noopener" className="text-emerald-300 underline">
                {l.text}
              </a>
            ) : (
              l.text
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
