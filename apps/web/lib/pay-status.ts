// One always-visible line under the Pay stage saying what is happening now, so the screen never leaves the
// wearer guessing (toasts come and go with the voice; this stays). It says the same thing as the OLED and the
// voice, and every end state says what to do next. Fixed words only: never the confirm code (OLED only,
// invariant 7), never a full address (toastSafe shortens anything that slips into a reason).
import type { AskPhase } from "./ask-pay.js";
import type { PayState } from "./pay-machine.js";
import { toastSafe } from "./toast.js";

export interface StatusOpts {
  /** This payment goes from the Railgun private balance (decided before policy; not just the toggle). */
  privateSend: boolean;
  micOn: boolean;
  /** "Want to pay?" ask in progress (shown only while no payment session runs). */
  ask?: AskPhase;
  /** Seconds since sending started (PAYING). */
  elapsedS?: number;
}

export const ASK_STATUS = "Asking: want to pay? Say yes to scan.";

const AGAIN = "Press Scan to try again.";

function cancelledText(reason: string): string {
  if (reason === "Glasses disconnected") return "Glasses disconnected. Nothing was paid. Reconnect them to pay.";
  if (reason.startsWith("Policy")) return `Denied (${toastSafe(reason.replace(/^Policy:\s*/, ""))}). Nothing was paid. ${AGAIN}`;
  if (reason.startsWith("Approval denied")) return `${toastSafe(reason)}. Nothing was paid. ${AGAIN}`;
  if (reason === "Stopped") return "Stopped. Nothing was paid. Press Scan to start again.";
  return `Cancelled: ${toastSafe(reason)}. Nothing was paid. ${AGAIN}`;
}

export function payStatus(st: PayState, o: StatusOpts): string {
  const idleish = st.s === "IDLE" || st.s === "NO_QR" || st.s === "NO_MATCH" || st.s === "PAID" || st.s === "CANCELLED" ||
    st.s === "FAILED" || st.s === "BRAIN_OFFLINE" || st.s === "NO_VERIFIED_RECIPIENT";
  if (idleish && o.ask && o.ask !== "idle") {
    return o.ask === "checking" ? "Checking your answer…" : o.micOn ? `${ASK_STATUS} Mic on.` : ASK_STATUS;
  }
  switch (st.s) {
    case "IDLE":
      return "Press Scan, then look at a QR code or the person you're paying.";
    case "SCANNING":
      return "Scanning… look at the QR code or the person you're paying.";
    case "NO_QR":
      return st.why === "wrong_network"
        ? `That QR is for another network. Nothing was paid. ${AGAIN}`
        : st.why === "not_wallet"
          ? `That QR isn't a payment code. ${AGAIN}`
          : `Nothing found to pay. ${AGAIN}`;
    case "QR_LOCKED":
      return "QR code found. Say the amount after the beep.";
    case "MATCHING":
      return "Looking for the recipient's phone…";
    case "NO_MATCH":
      return "Recipient not found. Ask them to open CPay Receive, then press Scan.";
    case "QUOTING":
      return "Asking the recipient for a one-time address…";
    case "NO_VERIFIED_RECIPIENT":
      return `Recipient couldn't be verified. Nothing was paid. ${AGAIN}`;
    case "LISTENING_AMOUNT":
      return o.micOn ? 'Listening… say the amount, like "pay 2 USDC".' : "Say the amount after the beep.";
    case "THINKING":
      return "Understanding the amount…";
    case "POLICY":
      return "Checking your spend limits…";
    case "NEEDS_APPROVAL":
      return "Over your limit: approve with World to continue, or Stop.";
    case "CONFIRMING":
      return st.phase === "tap"
        ? "Tap Confirm to pay, or Stop to cancel."
        : st.phase === "checking"
          ? "Checking what you said…"
          : o.micOn
            ? 'Listening… say "confirm" and the code on your glasses.'
            : 'Say "confirm" and the code shown on your glasses.';
    case "PAYING": {
      const t = o.elapsedS !== undefined && o.elapsedS > 0 ? ` ${o.elapsedS} s` : "";
      return o.privateSend ? `Sending privately…${t} (takes about 2 minutes).` : `Sending…${t}`;
    }
    case "PAID":
      return "Paid. Press Scan to pay again.";
    case "CANCELLED":
      return cancelledText(st.reason);
    case "BRAIN_OFFLINE":
      return `The voice agent (0G) is unreachable. Nothing was paid. ${AGAIN}`;
    case "FAILED":
      return st.maybeSent
        ? "Payment unconfirmed. It may have gone through: check Etherscan before paying again."
        : `Payment failed: ${toastSafe(st.reason.replace(/^(Private payment|Payment) failed:\s*/, ""))}. Nothing was paid. ${AGAIN}`;
  }
}
