// Error handling for /pay (pure helpers + one window guard). Every async path ends in a visible state; a payment
// that may already be on-chain is never reported as "nothing was paid" and is never retried automatically.
import { errText, toastSafe } from "./toast.js";

/** Short, actionable text for a getUserMedia / MediaRecorder failure. */
export function micErrorText(e: unknown): string {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone blocked: allow it for this site";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found: connect your earbuds";
  if (name === "NotReadableError" || name === "AbortError") return "Microphone busy in another app";
  return `Microphone error: ${errText(e)}`;
}

const TX_HASH_RE = /0x[0-9a-fA-F]{64}/;
/** viem errors that are thrown after (or while) a transaction was broadcast, so it may be on-chain. */
const AMBIGUOUS = new Set(["WaitForTransactionReceiptTimeoutError", "TransactionReceiptNotFoundError", "TimeoutError", "HttpRequestError"]);

export interface SendFailure {
  /** True when the transaction (or UserOperation) may have gone out: say "unconfirmed", never "nothing was paid". */
  maybeSent: boolean;
  reason: string;
}

/**
 * Classify an error thrown by a send (payDirect / payOneTime / Railgun pay). `stage` is the last stage the
 * sender reported ("proving" | "submitting" | "confirming" for Railgun). Fails towards "maybe sent": we would
 * rather make the wearer check than tell them nothing moved when it did.
 */
export function sendFailure(e: unknown, stage?: string): SendFailure {
  const text = errText(e);
  const chain: string[] = [];
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    const n = (x as { name?: unknown }).name;
    if (typeof n === "string") chain.push(n);
  }
  const reverted = /revert/i.test(text);
  const ambiguous =
    stage === "submitting" ||
    stage === "confirming" ||
    chain.some((n) => AMBIGUOUS.has(n)) ||
    (!reverted && TX_HASH_RE.test(e instanceof Error ? e.message : String(e)));
  if (ambiguous && !reverted) return { maybeSent: true, reason: `Payment unconfirmed: ${text}` };
  return { maybeSent: false, reason: `Payment failed: ${text}` };
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)} s`);
    this.name = "TimeoutError";
  }
}

/** Reject after `ms` (the underlying work may continue; callers ignore its late result via the session gen). */
export function withTimeout<T>(p: Promise<T>, ms: number, what = "request"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });
}

export const GENERIC_ERROR = "Something went wrong — nothing was paid";

/**
 * Log every unhandled promise rejection on this tab (message only, shortened: never addresses or data) and toast
 * a generic line, but only when no payment is in flight (then "nothing was paid" might be untrue; the payment's
 * own path reports it). Returns the uninstaller.
 */
export function installRejectionGuard(paymentInFlight: () => boolean, show: (text: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onRejection = (ev: PromiseRejectionEvent) => {
    console.warn(`[cpay/pay] unhandled rejection: ${toastSafe(errText(ev.reason))}`);
    if (!paymentInFlight()) show(GENERIC_ERROR);
  };
  window.addEventListener("unhandledrejection", onRejection);
  return () => window.removeEventListener("unhandledrejection", onRejection);
}
