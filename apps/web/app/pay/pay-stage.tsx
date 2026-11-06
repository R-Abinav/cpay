"use client";
// The one central stage of /pay, readable at arm's length: Scan -> live feed -> big amount -> done.
// One fixed status line (lib/pay-status.ts) says what is happening now (same words as the OLED + voice); spoken replies still show as toasts in
// sync with the voice; while 0G works, a calm orb.
// The confirm code is never shown on the phone (it is on the glasses OLED only).
import { payStatus } from "../../lib/pay-status.js";
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Address } from "../../components/ui.js";
import { railgunStore } from "../../lib/railgun.js";
import { isActive, type PayState, type Recipient } from "../../lib/pay-machine.js";
import { fmtUnits, txUrl } from "../../lib/wallet.js";
import type { PayController, PayView } from "./controller.js";
import { PayStepper } from "./pay-stepper.js";

function intentOf(st: PayState): { amount: string; token: string } | null {
  if ("intent" in st && st.intent) return st.intent;
  return null;
}

/** Who gets paid, in a few words (what the recipient chose to show, invariant 5). */
export function RecipientLine({ r }: { r: Recipient }) {
  if (r.kind === "address")
    return (
      <p className="text-sm text-neutral-400">
        to <Address value={r.address} className="text-neutral-300" /> <span className="text-amber-300">· public, not verified</span>
      </p>
    );
  if (r.kind === "private")
    return (
      <p className="text-sm text-neutral-400">
        to a one-time address <span className="text-emerald-300">· verified human ({r.tier})</span>
      </p>
    );
  return <p className="text-sm text-neutral-400">{r.kind === "cpay" ? "private CPay QR" : "matched face"} · verifying recipient</p>;
}

function Orb({ label }: { label: string }) {
  return (
    <span role="status" aria-label={label} className="grid h-28 w-28 place-items-center">
      <span className="cpay-orb block h-14 w-14 rounded-full bg-emerald-400/70" />
    </span>
  );
}

function MicOn() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-red-500/40 px-3 py-1 text-xs text-red-300">
      <span className="cpay-orb h-2 w-2 rounded-full bg-red-500" aria-hidden /> Mic on
    </span>
  );
}

function Amount({ amount, token, done }: { amount: string; token: string; done?: boolean }) {
  return (
    <div className={`flex flex-wrap items-baseline justify-center gap-x-3 ${done ? "text-emerald-400" : "text-neutral-50"}`}>
      <span className="break-all text-[clamp(3rem,20vw,6rem)] font-semibold leading-none tabular-nums tracking-tight">{amount}</span>
      <span className="text-2xl font-medium text-neutral-500">{token}</span>
    </div>
  );
}

export function PayStage({ view, ctrl, canScan = true }: { view: PayView; ctrl: PayController; canScan?: boolean }) {
  const st = view.state;
  const intent = intentOf(st);
  const recipient = "recipient" in st ? st.recipient : null;
  const active = isActive(st);

  let body;
  if (view.feedUrl) {
    body = (
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-neutral-800 bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={view.feedUrl} alt="Glasses camera, live, not stored" className="h-full w-full object-contain" />
        <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden /> LIVE · {view.stats.fps} fps
        </span>
      </div>
    );
  } else if (st.s === "PAID") {
    body = <PaidMoment st={st} view={view} />;
  } else if (intent && active) {
    body = (
      <div className="flex flex-col items-center gap-4 text-center">
        <Amount amount={intent.amount} token={intent.token} />
        {recipient && <RecipientLine r={recipient} />}
        {!view.micOn && (st.s === "PAYING" || st.s === "QUOTING" || st.s === "POLICY") && <Orb label="Working" />}
      </div>
    );
  } else if (active) {
    body = (
      <div className="flex flex-col items-center gap-4">
        <Orb label={view.micOn ? "Listening" : "Working"} />
      </div>
    );
  } else if (!canScan) {
    body = null;
  } else {
    body = (
      <button
        type="button"
        onClick={() => ctrl.startScan()}
        className="grid h-44 w-44 place-items-center rounded-full bg-emerald-500 text-3xl font-semibold text-black transition-colors hover:bg-emerald-400 active:bg-emerald-600"
      >
        Scan
      </button>
    );
  }

  return (
    <section aria-label="Payment" className="flex min-h-[50vh] flex-col items-center justify-center gap-5 py-6">
      {st.s !== "PAID" && <PayStepper st={st} />}
      {body}
      {view.micOn && <MicOn />}
      <p role="status" aria-live="polite" className="max-w-xs text-center text-base text-neutral-300">
        {payStatus(st, { privateSend: view.privateSend, micOn: view.micOn, ask: view.ask, elapsedS: view.elapsedS })}
      </p>
    </section>
  );
}

/** The big "Paid" moment: a check that draws itself, the amount, private/public, and links to the tx + 0G evidence. */
function PaidMoment({ st, view }: { st: Extract<PayState, { s: "PAID" }>; view: PayView }) {
  const isPrivate = st.recipient.kind === "private" || view.privateSend;
  const requestId = [...view.evidence].reverse().find((e) => e.requestId)?.requestId ?? null;
  return (
    <div className="relative flex w-full flex-col items-center gap-5 overflow-hidden rounded-3xl border border-emerald-500/20 bg-emerald-500/[0.04] px-5 py-8 text-center">
      <span aria-hidden className="cpay-glow pointer-events-none absolute -top-24 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-emerald-500/30 blur-3xl" />
      <div className="cpay-pop relative grid h-24 w-24 place-items-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/40">
        <svg viewBox="0 0 48 48" className="h-12 w-12 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path className="cpay-draw" d="M12 25l8 8 16-17" />
        </svg>
      </div>
      <div className="cpay-rise relative space-y-3" style={{ animationDelay: "200ms" }}>
        <Amount amount={st.intent.amount} token={st.intent.token} done />
        <div className="flex justify-center">
          {isPrivate ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> Private
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden /> Public
            </span>
          )}
        </div>
        <RecipientLine r={st.recipient} />
      </div>
      <div className="cpay-rise relative flex flex-wrap justify-center gap-2" style={{ animationDelay: "350ms" }}>
        <a
          href={txUrl(st.txHash)}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-11 items-center rounded-2xl border border-neutral-800 px-4 text-sm font-medium text-emerald-300 hover:border-emerald-500/40"
        >
          View transaction ↗
        </a>
        {requestId && (
          <Link
            href="/evidence"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-2xl border border-neutral-800 px-4 text-sm font-medium text-neutral-300 hover:border-emerald-500/40"
          >
            0G receipt <span className="font-mono text-xs text-neutral-500">{requestId.length > 12 ? `${requestId.slice(0, 8)}…` : requestId}</span>
          </Link>
        )}
      </div>
    </div>
  );
}

/** The one action row under the stage: Stop always works while anything runs (cancel works everywhere). */
export function PayActions({ view, ctrl, canScan = true }: { view: PayView; ctrl: PayController; canScan?: boolean }) {
  const st = view.state;
  const active = isActive(st);
  const showScan = canScan && !active && (!!view.feedUrl || st.s === "PAID");
  return (
    <div className="space-y-3">
      {st.s === "NEEDS_APPROVAL" && (
        <>
          <button
            onClick={() => ctrl.approveWithWorld()}
            disabled={view.approval.busy}
            className="min-h-16 w-full rounded-2xl bg-white px-5 text-lg font-semibold text-black disabled:opacity-50"
          >
            {view.approval.busy ? "Waiting for World…" : "Approve with World"}
          </button>
          {view.approval.url && (
            <a href={view.approval.url} target="_blank" rel="noreferrer noopener" className="block min-h-11 py-2 text-center text-sm text-neutral-300 underline">
              Window didn&apos;t open? Continue in World
            </a>
          )}
        </>
      )}
      {st.s === "CONFIRMING" && st.phase === "tap" && (
        <button onClick={() => ctrl.confirmTap()} className="min-h-16 w-full rounded-2xl bg-emerald-500 text-xl font-semibold text-black">
          Confirm {st.intent.amount} {st.intent.token}
        </button>
      )}
      {!active && <PrivateToggle on={view.privateMode} onChange={(on) => ctrl.setPrivateMode(on)} />}
      {showScan && (
        <button onClick={() => ctrl.startScan()} className="min-h-14 w-full rounded-2xl bg-emerald-500 text-lg font-semibold text-black">
          {st.s === "PAID" ? "Scan again" : "Scan"}
        </button>
      )}
      {(active || view.feedUrl || view.ask !== "idle") && (
        <button
          onClick={() => ctrl.stop()}
          className="min-h-14 w-full rounded-2xl border border-red-500/40 text-lg font-semibold text-red-300 hover:bg-red-500/10"
        >
          Stop
        </button>
      )}
    </div>
  );
}

/** "Pay privately" (Railgun): used when the spendable private USDC covers the amount, else the agent wallet pays. */
function PrivateToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const rg = useSyncExternalStore(railgunStore.subscribe, railgunStore.get, railgunStore.get);
  const note =
    rg.status === "unavailable"
      ? "Private payments unavailable"
      : rg.balances
        ? `${fmtUnits(rg.balances.usdc.valid, 6)} USDC private`
        : rg.status === "locked"
          ? ""
          : "Loading private balance…";
  return (
    <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-neutral-900 px-4 text-sm">
      <span>
        Pay privately <span className="text-neutral-500">· {note}</span>
      </span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-emerald-500" />
    </label>
  );
}
