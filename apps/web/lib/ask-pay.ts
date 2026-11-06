// "Want to pay?" hands-free start (pure: no I/O). When YOUR glasses come online while the wallet is unlocked and
// the Pay tab is open, the phone asks once: OLED + voice, then a fixed 5 s mic window, 0G STT, and this
// DETERMINISTIC matcher decides (never an LLM). Asked again once after each payment ends. Never on a timer, never
// a wake word: the only triggers are "glasses came online" and "a payment just ended", and every ask is one-shot.

/** What the wearer's answer means. Only "yes" starts a scan; everything else (incl. silence) is "not now". */
export type AskAnswer = "yes" | "no" | "unclear" | "silence";

const YES = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "pay", "scan"]);
/** A refusal word anywhere wins over a yes word ("no, don't pay" is a no). */
const NO = new Set(["no", "nope", "nah", "cancel", "stop", "dont", "not", "later", "wait", "never"]);

/** Deterministic, phone-side. `text` is the 0G transcript (kept in memory only, never logged). */
export function matchWantToPay(text: string): AskAnswer {
  const words = text
    .toLowerCase()
    .replace(/o\.k\./g, "ok")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "silence";
  if (words.some((w) => NO.has(w))) return "no";
  if (words.some((w) => YES.has(w))) return "yes";
  return "unclear";
}

export type AskPhase = "idle" | "prompting" | "listening" | "checking";

export interface AskState {
  /** Last glasses state seen (paired + online). An offline -> online edge arms the ask. */
  online: boolean;
  /** One ask is owed (glasses just came online, or a payment just ended). Cleared when the ask starts. */
  armed: boolean;
  phase: AskPhase;
}

export type AskEvent =
  | { t: "GLASSES"; online: boolean }
  /** A payment ended (PAID, CANCELLED, FAILED) and its closing voice finished. */
  | { t: "PAYMENT_ENDED" }
  | { t: "START" }
  | { t: "LISTEN" }
  | { t: "RECORDED" }
  | { t: "ANSWER" }
  /** Scan tapped, Stop tapped, glasses dropped, mic/STT error, Pay tab closed. */
  | { t: "CANCEL" };

export const initialAsk: AskState = { online: false, armed: false, phase: "idle" };

export function askReducer(st: AskState, ev: AskEvent): AskState {
  switch (ev.t) {
    case "GLASSES":
      if (ev.online === st.online) return st;
      // Came online: owe one ask. Went offline: drop any ask in progress (the controller stops the mic).
      return ev.online ? { ...st, online: true, armed: true } : { online: false, armed: false, phase: "idle" };
    case "PAYMENT_ENDED":
      return st.phase === "idle" ? { ...st, armed: true } : st;
    case "START":
      return st.phase === "idle" && st.armed ? { ...st, armed: false, phase: "prompting" } : st;
    case "LISTEN":
      return st.phase === "prompting" ? { ...st, phase: "listening" } : st;
    case "RECORDED":
      return st.phase === "listening" ? { ...st, phase: "checking" } : st;
    case "ANSWER":
      return st.phase === "checking" ? { ...st, phase: "idle" } : st;
    case "CANCEL":
      return st.phase === "idle" && !st.armed ? st : { ...st, armed: false, phase: "idle" };
  }
}

/** Everything else that must hold right now for the phone to ask. */
export interface AskContext {
  /** The "Ask 'Want to pay?'" setting (default on). */
  enabled: boolean;
  walletUnlocked: boolean;
  /** The Pay tab is open (the controller is attached). */
  payTabOpen: boolean;
  /** No payment session is running (Scan would start one). */
  payIdle: boolean;
  /** Hub connected and the glasses online right now (glassesState "paired"): the OLED and ticket work. */
  glassesReady: boolean;
}

export function shouldAsk(st: AskState, c: AskContext): boolean {
  return st.armed && st.phase === "idle" && st.online && c.glassesReady && c.enabled && c.walletUnlocked && c.payTabOpen && c.payIdle;
}

// ---------------------------------------------------------------- setting (this phone only)
const KEY = "cpay.askWantToPay";

/** Default ON. Stored in localStorage on this phone only. */
export function askEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(KEY) !== "off";
}
export function setAskEnabled(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, on ? "on" : "off");
}
