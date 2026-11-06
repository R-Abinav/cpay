"use client";
// A compact visual step indicator for /pay, derived only from the controller's PayState (presentation only:
// no new on-screen words beyond step names). Order follows the real flow: the QR is read, the amount is heard,
// then a private recipient is verified (a public address has nothing to verify: shown as skipped).
// Terminal states (cancelled / failed) carry no recipient, so the last step reached is remembered here.
import { useRef } from "react";
import type { PayState, Recipient } from "../../lib/pay-machine.js";

type StepId = "scan" | "amount" | "recipient" | "confirm" | "paying" | "paid";
type Mark = "todo" | "now" | "done" | "skip" | "stop" | "fail";
type Kind = "public" | "private" | null;

const ORDER: StepId[] = ["scan", "amount", "recipient", "confirm", "paying", "paid"];

const kindOf = (r: Recipient | undefined): Kind => (!r ? null : r.kind === "address" ? "public" : "private");

/** Which step is running now for an active state (null: not a running step). */
function currentStep(st: PayState): StepId | null {
  switch (st.s) {
    case "SCANNING":
    case "MATCHING":
      return "scan";
    case "QR_LOCKED":
    case "LISTENING_AMOUNT":
    case "THINKING":
      return "amount";
    case "QUOTING":
      return "recipient";
    case "POLICY":
    case "NEEDS_APPROVAL":
    case "CONFIRMING":
      return "confirm";
    case "PAYING":
      return "paying";
    case "PAID":
      return "paid";
    default:
      return null;
  }
}

/** How a session that ended without paying ended: red for a deliberate stop, amber for a failure. */
function endTone(st: PayState): "stop" | "fail" | null {
  if (st.s === "CANCELLED") return "stop";
  if (st.s === "FAILED" || st.s === "BRAIN_OFFLINE" || st.s === "NO_VERIFIED_RECIPIENT" || st.s === "NO_QR" || st.s === "NO_MATCH") return "fail";
  return null;
}

export function PayStepper({ st }: { st: PayState }) {
  const mem = useRef<{ step: StepId; kind: Kind }>({ step: "scan", kind: null });
  const now = currentStep(st);
  if (st.s === "IDLE" || st.s === "SCANNING") mem.current = { step: "scan", kind: null };
  if (now) {
    const r = "recipient" in st ? st.recipient : undefined;
    mem.current = { step: now, kind: kindOf(r) ?? mem.current.kind };
  }
  if (st.s === "IDLE") return null;
  // A scan that found nothing failed at the scan step; a missing verified recipient at the recipient step.
  const step: StepId = st.s === "NO_QR" || st.s === "NO_MATCH" ? "scan" : st.s === "NO_VERIFIED_RECIPIENT" ? "recipient" : (now ?? mem.current.step);
  const kind = mem.current.kind;
  const end = endTone(st);
  const at = ORDER.indexOf(step);

  const mark = (id: StepId, i: number): Mark => {
    if (id === "recipient" && kind === "public") return "skip";
    if (st.s === "PAID") return "done";
    if (i < at) return "done";
    if (i === at) return end ?? "now";
    return "todo";
  };
  const label = (id: StepId): string => {
    if (id === "recipient") return kind === "public" ? "Public" : "Verified";
    return { scan: "Scan", amount: "Amount", confirm: "Confirm", paying: "Paying", paid: "Paid" }[id];
  };

  return (
    <ol aria-label="Payment steps" className="grid w-full max-w-sm grid-cols-6 gap-1">
      {ORDER.map((id, i) => {
        const m = mark(id, i);
        return (
          <li key={id} className="flex flex-col items-center gap-1.5" aria-current={m === "now" ? "step" : undefined}>
            <span className="relative flex w-full items-center justify-center">
              {i > 0 && (
                <span
                  aria-hidden
                  style={{ right: "calc(50% + 0.875rem)", width: "calc(100% - 1.5rem)" }}
                  className={`absolute top-1/2 h-px -translate-y-1/2 ${m !== "todo" ? "bg-emerald-500/50" : "bg-neutral-800"}`}
                />
              )}
              <Dot m={m} />
            </span>
            <span
              className={`text-[10px] font-medium leading-none ${
                m === "now" ? "text-emerald-300" : m === "done" ? "text-neutral-300" : m === "stop" ? "text-red-300" : m === "fail" ? "text-amber-300" : "text-neutral-600"
              }`}
            >
              {label(id)}
              <span className="sr-only">{` (${m === "now" ? "in progress" : m === "done" ? "done" : m === "skip" ? "not needed" : m === "stop" ? "cancelled" : m === "fail" ? "stopped" : "to do"})`}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Dot({ m }: { m: Mark }) {
  if (m === "done")
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/50">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  if (m === "now")
    return (
      <span className="relative grid h-7 w-7 place-items-center rounded-full ring-1 ring-emerald-400/70">
        <span className="cpay-step-ping absolute inset-0 rounded-full bg-emerald-400/30" aria-hidden />
        <span className="cpay-orb h-2.5 w-2.5 rounded-full bg-emerald-400" aria-hidden />
      </span>
    );
  if (m === "stop")
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full bg-red-500/15 text-red-400 ring-1 ring-red-500/50">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      </span>
    );
  if (m === "fail")
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full bg-amber-500/15 text-sm font-bold text-amber-300 ring-1 ring-amber-500/50" aria-hidden>
        !
      </span>
    );
  if (m === "skip")
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full border border-dashed border-neutral-700 text-neutral-600" aria-hidden>
        <span className="h-px w-2.5 bg-neutral-600" />
      </span>
    );
  return <span className="grid h-7 w-7 place-items-center rounded-full border border-neutral-800" aria-hidden />;
}
