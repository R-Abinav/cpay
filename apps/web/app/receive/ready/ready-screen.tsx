"use client";
// Ready-to-receive mode: a full-screen, keep-awake screen so a recipient can leave the phone on the table and get
// paid (face path or private CPay QR). Web pages are suspended when the screen locks, so we hold a Screen Wake
// Lock while this screen is visible, dim it after ~20 s (CSS overlay, tap to undim) and release on exit.
// The event feed shows fixed texts only (lib/ready-mode.ts): never addresses, amounts, embeddings or peer ids.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState } from "react";
import { AddressQr } from "../../../components/address-qr.js";
import { Button, ErrorNote } from "../../../components/ui.js";
import { errorMessage } from "../../../lib/deps.js";
import { useWallet } from "../../../lib/hooks.js";
import { publicConfig } from "../../../lib/public-config.js";
import {
  WakeLockKeeper,
  describeEvent,
  dimReducer,
  initialDim,
  msUntilDim,
  pushFeed,
  readyHeadline,
  type FeedEntry,
  type FeedTone,
  type WakeEnv,
  type WakeLockState,
} from "../../../lib/ready-mode.js";
import { getRecipient, type RecipientStatus } from "../../../lib/recipient-service.js";
import { unlockWallet } from "../../../lib/wallet.js";

function useRecipient(): RecipientStatus {
  const [s, set] = useState<RecipientStatus>(() => getRecipient().status);
  useEffect(() => getRecipient().onStatus(set), []);
  return s;
}

function browserWakeEnv(): WakeEnv {
  const nav = navigator as Navigator & { wakeLock?: WakeEnv["wakeLock"] };
  return {
    wakeLock: nav.wakeLock,
    isVisible: () => document.visibilityState === "visible",
    onVisibility: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}

const WAKE_TEXT: Record<WakeLockState, string> = {
  idle: "Screen stay-awake: starting…",
  active: "Screen stays awake",
  released: "Screen stay-awake paused by the system",
  denied: "Couldn't keep the screen awake",
  unsupported: "This browser can't keep the screen awake: set Auto-Lock to Never while receiving",
};

const FEED_TONE: Record<FeedTone, string> = {
  ok: "text-emerald-300",
  info: "text-sky-300",
  warn: "text-amber-300",
  muted: "text-neutral-400",
};

const HEAD_TONE = {
  ready: "border-emerald-500/60 bg-emerald-500/10 text-emerald-200",
  working: "border-amber-500/50 bg-amber-500/10 text-amber-200",
  blocked: "border-red-500/50 bg-red-500/10 text-red-200",
} as const;

export function ReadyScreen() {
  const router = useRouter();
  const rs = useRecipient();
  const wallet = useWallet();
  const [dim, dispatch] = useReducer(dimReducer, 0, () => initialDim(Date.now()));
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [wake, setWake] = useState<{ state: WakeLockState; detail: string }>({ state: "idle", detail: "" });
  const [err, setErr] = useState<string | null>(null);
  const [, setClock] = useState(0);

  // Wake lock for as long as this screen is mounted (re-acquired on visibilitychange; released on exit).
  useEffect(() => {
    const k = new WakeLockKeeper(browserWakeEnv(), (state, detail) => setWake({ state, detail }));
    void k.start();
    return () => void k.stop();
  }, []);

  // Recipient: start, and after the phone comes back from sleep/background reconnect at once (no backoff).
  useEffect(() => {
    const r = getRecipient();
    void r.start();
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      dispatch({ type: "activity", at: Date.now() });
      void r.start();
      const s = r.status.relay;
      if (s === "closed" || s === "off") r.reconnectNow();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Privacy-safe event feed; important events wake the screen.
  useEffect(
    () =>
      getRecipient().onEvent((e) => {
        setFeed((f) => pushFeed(f, e));
        dispatch({ type: "event", at: e.at, kind: e.kind });
      }),
    [],
  );

  // Dim timer.
  useEffect(() => {
    const ms = msUntilDim(dim, Date.now());
    if (ms === null) return;
    const t = setTimeout(() => dispatch({ type: "tick", at: Date.now() }), ms + 50);
    return () => clearTimeout(t);
  }, [dim]);

  // Clock for the reconnect countdown (only while a reconnect is scheduled).
  useEffect(() => {
    if (!rs.reconnectAt) return;
    const t = setInterval(() => setClock((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [rs.reconnectAt]);

  // Reuse the service's QR string (its format is owned by recipient-service; re-read on every status change).
  const qr = getRecipient().cpayQr();
  const qrVisible = rs.hasCard && !!wallet && !rs.invisible && !!qr;

  // Quotes without a face match are answered only while the private QR is on screen (and the page is visible).
  useEffect(() => {
    const r = getRecipient();
    const sync = () => r.setShowingCpayQr(qrVisible && document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      r.setShowingCpayQr(false);
    };
  }, [qrVisible]);

  const head = readyHeadline({
    status: rs,
    walletUnlocked: !!wallet,
    relayConfigured: !!publicConfig.relayUrl,
    qrReady: !!qr,
    now: Date.now(),
  });

  const touch = () => dispatch({ type: "activity", at: Date.now() });

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-neutral-950 text-neutral-100"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      onPointerDownCapture={touch}
      onKeyDownCapture={touch}
    >
      <div className="mx-auto w-full max-w-md flex-1 space-y-4 p-4">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Ready to receive</h1>
          <Button tone="secondary" onClick={() => router.push("/receive")} aria-label="Exit ready mode">
            Exit
          </Button>
        </header>

        <section role="status" aria-live="polite" className={`rounded-2xl border p-5 ${HEAD_TONE[head.tone]}`}>
          <p className="text-3xl font-bold leading-tight">{head.title}</p>
          {head.detail && <p className="mt-1 text-sm opacity-80">{head.detail}</p>}
          <p className="mt-3 flex items-center gap-2 text-xs text-neutral-300">
            <span
              className={`h-2 w-2 rounded-full ${rs.relay === "open" ? "bg-emerald-400" : rs.relay === "connecting" || rs.reconnectAt ? "bg-amber-400" : "bg-neutral-500"}`}
              aria-hidden
            />
            Relay: {rs.relay === "open" ? "connected" : rs.relay === "connecting" ? "connecting" : rs.reconnectAt ? "reconnecting" : rs.relay}
          </p>
        </section>

        {err && <ErrorNote>{err}</ErrorNote>}

        {!wallet && rs.hasCard && !rs.invisible && (
          <Button className="w-full" onClick={() => unlockWallet().catch((e) => setErr(errorMessage(e)))}>
            Unlock with passkey
          </Button>
        )}

        {qrVisible && qr && (
          <section className="flex flex-col items-center gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
            <AddressQr value={qr} size={260} alt="Your private CPay QR" />
            <p className="text-center text-xs text-neutral-500">Private CPay QR: no address, only a relay key. Changes on every reconnect.</p>
          </section>
        )}

        <section className="grid grid-cols-2 gap-2 text-sm">
          <Readiness ok={rs.hasCard} label="World ID card" fix={{ href: "/receive", label: "Verify on Receive" }} />
          <Readiness ok={rs.hasTemplate} label="Face pay" optional fix={{ href: "/receive", label: "Enrol on Receive" }} />
          <Readiness ok={!rs.invisible} label={rs.invisible ? "Invisible" : "Visible"} fix={{ href: "/receive", label: "Turn off invisible" }} />
          <Readiness ok={!!wallet} label={wallet ? "Wallet unlocked" : "Wallet locked"} />
        </section>

        <div className="flex gap-2">
          <Button tone="secondary" className="flex-1" disabled={rs.relay === "open" || !rs.hasCard || rs.invisible} onClick={() => getRecipient().reconnectNow()}>
            Reconnect
          </Button>
        </div>

        <p className={`text-xs ${wake.state === "active" ? "text-neutral-500" : "text-amber-300"}`}>
          {WAKE_TEXT[wake.state]}
          {wake.state === "denied" && wake.detail ? ` (${wake.detail})` : ""}. Keep CPay in the foreground; a locked screen pauses receiving.
        </p>

        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-300">Live (this phone only, since you opened this screen)</h2>
          <ul className="space-y-1.5 text-sm">
            {feed.length === 0 && <li className="text-neutral-500">Waiting for payers…</li>}
            {feed.map((e) => {
              const d = describeEvent(e.kind);
              return (
                <li key={`${e.at}-${e.kind}`} className={FEED_TONE[d.tone]}>
                  <span className="mr-2 font-mono text-xs text-neutral-500">{new Date(e.at).toLocaleTimeString()}</span>
                  {d.text}
                  {e.count > 1 && <span className="text-neutral-500"> ×{e.count}</span>}
                  {d.link && (
                    <Link href={d.link.href} className="ml-2 underline">
                      {d.link.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {dim.dimmed && (
        <button
          type="button"
          aria-label="Screen dimmed. Tap to wake."
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/85 pb-16 text-sm text-neutral-500"
          onClick={touch}
        >
          {head.title} · tap to wake
        </button>
      )}
    </div>
  );
}

function Readiness({ ok, label, fix, optional }: { ok: boolean; label: string; fix?: { href: string; label: string }; optional?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${ok ? "border-emerald-500/40 bg-emerald-500/5" : optional ? "border-neutral-700 bg-neutral-900" : "border-amber-500/40 bg-amber-500/5"}`}>
      <p className="font-medium">
        <span aria-hidden>{ok ? "✓ " : "· "}</span>
        {label}
        {!ok && optional ? " (off)" : ""}
      </p>
      {!ok && fix && (
        <Link href={fix.href} className="text-xs text-neutral-300 underline">
          {fix.label}
        </Link>
      )}
    </div>
  );
}
