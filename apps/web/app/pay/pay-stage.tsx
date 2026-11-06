"use client";
// The one central stage of /pay, readable at arm's length: Scan -> live feed -> big amount -> done.
// One fixed status line (lib/pay-status.ts) says what is happening now; spoken replies still show as toasts in
// sync with the voice; while 0G works, a calm orb.
// The confirm code is never shown on the phone (it is on the glasses OLED only).
import { payStatus } from "../../lib/pay-status.js";
import { useSyncExternalStore } from "react";
import { CheckIcon } from "../../components/icons.js";
import { railgunStore } from "../../lib/railgun.js";
import { isActive, type PayState, type Recipient } from "../../lib/pay-machine.js";
import { fmtUnits, txUrl } from "../../lib/wallet.js";
import type { PayController, PayView } from "./controller.js";

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function intentOf(st: PayState): { amount: string; token: string } | null {
  if ("intent" in st && st.intent) return st.intent;
  return null;
}

/** Who gets paid, in a few words (what the recipient chose to show, invariant 5). */
export function RecipientLine({ r }: { r: Recipient }) {
  if (r.kind === "address")
    return (
      <p className="text-sm text-neutral-400">
        to <span className="font-mono text-neutral-300">{short(r.address)}</span> <span className="text-amber-300">· public, not verified</span>
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

export function PayStage({ view, ctrl }: { view: PayView; ctrl: PayController }) {
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
    body = (
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full border border-emerald-500/50 text-emerald-400">
          <CheckIcon size={28} />
        </span>
        <Amount amount={st.intent.amount} token={st.intent.token} done />
        <RecipientLine r={st.recipient} />
        <a href={txUrl(st.txHash)} target="_blank" rel="noreferrer noopener" className="min-h-11 px-3 py-2 text-sm text-emerald-300 underline">
          View transaction ↗
        </a>
      </div>
    );
  } else if (intent && active) {
    body = (
      <div className="flex flex-col items-center gap-4 text-center">
        <Amount amount={intent.amount} token={intent.token} />
        {recipient && <RecipientLine r={recipient} />}
        {view.micOn ? <MicOn /> : (st.s === "PAYING" || st.s === "QUOTING" || st.s === "POLICY") && <Orb label="Working" />}
      </div>
    );
  } else if (active) {
    body = (
      <div className="flex flex-col items-center gap-4">
        <Orb label={view.micOn ? "Listening" : "Working"} />
        {view.micOn && <MicOn />}
      </div>
    );
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
      {body}
      <p role="status" aria-live="polite" className="max-w-xs text-center text-base text-neutral-300">
        {payStatus(st, { privateMode: view.privateMode, micOn: view.micOn })}
      </p>
    </section>
  );
}

/** The one action row under the stage: Stop always works while anything runs (cancel works everywhere). */
export function PayActions({ view, ctrl }: { view: PayView; ctrl: PayController }) {
  const st = view.state;
  const active = isActive(st);
  const showScan = !active && (!!view.feedUrl || st.s === "PAID");
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
      {(active || view.feedUrl) && (
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
