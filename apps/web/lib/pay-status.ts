// One always-visible line under the Pay stage saying what is happening now, so the screen never leaves the
// wearer guessing (toasts come and go with the voice; this stays). Fixed words only: never the confirm code
// (OLED only, invariant 7), never a full address (toastSafe shortens anything that slips into a reason).
import type { PayState } from "./pay-machine.js";
import { toastSafe } from "./toast.js";

export function payStatus(st: PayState, o: { privateMode: boolean; micOn: boolean }): string {
  switch (st.s) {
    case "IDLE":
      return "Press Scan, then look at a QR code.";
    case "SCANNING":
      return "Looking for a QR code… hold it steady in front of the glasses.";
    case "NO_QR":
      return st.why === "wrong_network"
        ? "That QR is for another network. Press Scan to try again."
        : st.why === "not_wallet"
          ? "That QR isn't a payment code. Press Scan to try again."
          : "No QR code found. Press Scan to try again.";
    case "QR_LOCKED":
      return "QR read. Get ready to say the amount.";
    case "MATCHING":
      return "Looking for the recipient's phone…";
    case "NO_MATCH":
      return "Recipient not found. Ask them to open CPay Receive, then press Scan.";
    case "QUOTING":
      return "Asking the recipient for a one-time address…";
    case "NO_VERIFIED_RECIPIENT":
      return "Recipient couldn't be verified. Nothing was paid.";
    case "LISTENING_AMOUNT":
      return o.micOn ? 'Listening… say the amount, like "pay 2 USDC".' : "Get ready to say the amount.";
    case "THINKING":
      return "Understanding the amount…";
    case "POLICY":
      return "Checking your spend limits…";
    case "NEEDS_APPROVAL":
      return "Over your limit: approve with World to continue.";
    case "CONFIRMING":
      return st.phase === "tap"
        ? "Tap Confirm to pay, or Stop to cancel."
        : st.phase === "checking"
          ? "Checking what you said…"
          : 'Say "confirm" and the code shown on your glasses.';
    case "PAYING":
      return o.privateMode ? "Sending privately… this takes about 2 minutes." : "Sending…";
    case "PAID":
      return "Paid.";
    case "CANCELLED":
      return "Cancelled. Nothing was paid.";
    case "BRAIN_OFFLINE":
      return "The voice agent (0G) is unreachable. Nothing was paid.";
    case "FAILED":
      return `Payment failed, nothing was paid: ${toastSafe(st.reason)}`;
  }
}
