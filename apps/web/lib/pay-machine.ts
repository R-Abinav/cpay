// The /pay session as a pure reducer (docs/ARCHITECTURE.md "(2) Paying": SCAN, AMOUNT, POLICY, CONFIRM, PAY).
// No side effects here: the controller (app/pay/controller.ts) performs I/O and feeds events back in.
// Every limit lives in LIMITS so the tests and the UI agree.

export const PAY_LIMITS = {
  /** Camera on at most this long without a valid QR (invariant 8). */
  scanMs: 30_000,
  /** Camera stays on this long after a miss so the wearer can re-aim. */
  reaimMs: 3_000,
  /** Voice tries for the amount: the first + one retry. */
  amountTries: 2,
  /** Voice tries for the spoken confirm code before the tap fallback. */
  confirmVoiceTries: 2,
  /** Whole confirm step. */
  confirmMs: 60_000,
} as const;

export type Recipient =
  | { kind: "address"; address: string; chainId?: number; token?: string; amount?: string }
  /** CPay QR scanned: the recipient phone's relay peer + the QR's one-time secret; the destination comes later from its verified claim */
  | { kind: "cpay"; peerId: string; pub: string; qrSecret: string }
  /** Face matched (pay protocol v2 round 1): the one peer that answered + the round-1 nonce */
  | { kind: "face"; peerId: string; pub: string; matchSecret: string }
  /** After QUOTE: a fresh one-time address whose BBS proof verified against bindingDigest */
  | { kind: "private"; via: "cpay" | "face"; peerId: string; destination: string; tier: string };

/** Recipients whose destination must still be fetched + verified (QUOTE step). */
export type PendingPrivate = Extract<Recipient, { kind: "cpay" | "face" }>;
export const needsQuote = (r: Recipient): r is PendingPrivate => r.kind === "cpay" || r.kind === "face";

export type MatchOutcome =
  | { ok: true; peerId: string; pub: string; matchSecret: string }
  | { ok: false; reason: "none" | "multiple"; count: number };

export type Intent = { amount: string; token: string };
export type Decision = "allow" | "needs_approval" | "deny";
export type ConfirmMatch = "confirmed" | "cancelled" | "unclear";

export type PayState =
  | { s: "IDLE" }
  | { s: "SCANNING"; startedAt: number; lastUnsupported: "not_wallet" | "wrong_network" | null }
  | { s: "NO_QR"; why: "none" | "not_wallet" | "wrong_network" }
  | { s: "QR_LOCKED"; recipient: Recipient }
  /** Face probe sent to nearby phones; collecting sealed "match" answers (PAY2_LIMITS.matchWaitMs). */
  | { s: "MATCHING"; startedAt: number }
  /** Nobody matched. Tap Scan to retry. */
  | { s: "NO_MATCH"; why: "none" }
  /** Asking the recipient phone for a fresh one-time address + proof bound to this exact payment. */
  | { s: "QUOTING"; recipient: PendingPrivate; intent: Intent; startedAt: number }
  /** The claim didn't arrive in time, or its proof didn't verify. Nothing paid. */
  | { s: "NO_VERIFIED_RECIPIENT"; reason: string }
  | { s: "LISTENING_AMOUNT"; recipient: Recipient; tries: number }
  | { s: "THINKING"; recipient: Recipient; tries: number; intent?: Intent }
  | { s: "POLICY"; recipient: Recipient; intent: Intent }
  | { s: "NEEDS_APPROVAL"; recipient: Recipient; intent: Intent; reason: string }
  | {
      s: "CONFIRMING";
      recipient: Recipient;
      intent: Intent;
      code: number;
      startedAt: number;
      voiceTries: number;
      phase: "listening" | "checking" | "tap";
    }
  | { s: "PAYING"; recipient: Recipient; intent: Intent }
  | { s: "PAID"; recipient: Recipient; intent: Intent; txHash: string }
  | { s: "CANCELLED"; reason: string }
  | { s: "BRAIN_OFFLINE"; detail: string }
  | { s: "FAILED"; reason: string };

export type PayEvent =
  | { t: "SCAN"; now: number }
  | { t: "QR_FOUND"; recipient: Recipient }
  | { t: "QR_UNSUPPORTED"; why: "not_wallet" | "wrong_network" }
  | { t: "SCAN_TIMEOUT" }
  | { t: "FACE_PROBED"; now: number }
  | { t: "MATCH_RESULT"; result: MatchOutcome }
  | { t: "QUOTE_START"; now: number }
  | { t: "QUOTE_VERIFIED"; destination: string; tier: string }
  | { t: "QUOTE_FAILED"; reason: string }
  | { t: "AMOUNT_LISTEN" }
  | { t: "AMOUNT_RECORDED" }
  | { t: "AMOUNT_HEARD"; intent: Intent }
  | { t: "AMOUNT_REFUSED" }
  | { t: "BRAIN_OFFLINE"; detail: string }
  | { t: "POLICY"; decision: Decision; reason?: string }
  /** World Agent Pass finished; approved only after the phone verified the signed token for this payment. */
  | { t: "APPROVAL_RESULT"; approved: boolean; reason?: string }
  | { t: "CONFIRM_START"; code: number; now: number }
  | { t: "CONFIRM_RECORDED" }
  | { t: "CONFIRM_RESULT"; match: ConfirmMatch }
  | { t: "CONFIRM_TAP" }
  | { t: "TICK"; now: number }
  | { t: "PAID"; txHash: string }
  | { t: "FAIL"; reason: string }
  | { t: "STOP"; reason?: string }
  | { t: "RESET" };

export const initialPayState: PayState = { s: "IDLE" };

/** States where a session is running (Scan is disabled, Stop is shown). */
export function isActive(st: PayState): boolean {
  return !["IDLE", "NO_QR", "NO_MATCH", "PAID", "CANCELLED", "BRAIN_OFFLINE", "FAILED", "NO_VERIFIED_RECIPIENT"].includes(st.s);
}

const cancel = (reason: string): PayState => ({ s: "CANCELLED", reason });
const lockQr = (r: Recipient): PayState => ({ s: "QR_LOCKED", recipient: r });

export function payReducer(st: PayState, ev: PayEvent): PayState {
  // Global events first.
  switch (ev.t) {
    case "RESET":
      return initialPayState;
    case "STOP":
      // Stop can't recall a transaction being signed/sent, and never hides one that went out.
      if (st.s === "PAID" || st.s === "PAYING") return st;
      return isActive(st) ? cancel(ev.reason ?? "Stopped") : st;
    case "BRAIN_OFFLINE":
      return isActive(st) ? { s: "BRAIN_OFFLINE", detail: ev.detail } : st;
    case "FAIL":
      return isActive(st) ? { s: "FAILED", reason: ev.reason } : st;
    case "SCAN":
      // One tap starts (or retries) a fresh 30 s scan. Never while money could move.
      if (isActive(st)) return st;
      return { s: "SCANNING", startedAt: ev.now, lastUnsupported: null };
  }

  switch (st.s) {
    case "SCANNING":
      if (ev.t === "QR_FOUND") return lockQr(ev.recipient);
      // A stable centred face: the controller embedded it and sent the sealed probe. A QR seen first wins.
      if (ev.t === "FACE_PROBED") return { s: "MATCHING", startedAt: ev.now };
      if (ev.t === "QR_UNSUPPORTED") return { ...st, lastUnsupported: ev.why };
      if (ev.t === "SCAN_TIMEOUT") return { s: "NO_QR", why: st.lastUnsupported ?? "none" };
      if (ev.t === "TICK" && ev.now - st.startedAt >= PAY_LIMITS.scanMs) {
        return { s: "NO_QR", why: st.lastUnsupported ?? "none" };
      }
      return st;

    case "NO_QR":
      // Re-aim grace: a QR read in the 3 s after a miss still counts.
      if (ev.t === "QR_FOUND") return lockQr(ev.recipient);
      return st;

    case "MATCHING":
      if (ev.t === "MATCH_RESULT") {
        const r = ev.result;
        if (r.ok) return { s: "QR_LOCKED", recipient: { kind: "face", peerId: r.peerId, pub: r.pub, matchSecret: r.matchSecret } };
        // Two phones claiming the same face is never resolved by guessing: abort.
        if (r.reason === "multiple") return cancel(`${r.count} people matched: aborted`);
        return { s: "NO_MATCH", why: "none" };
      }
      return st;

    case "QR_LOCKED":
      if (ev.t === "AMOUNT_LISTEN") return { s: "LISTENING_AMOUNT", recipient: st.recipient, tries: 1 };
      return st;

    case "LISTENING_AMOUNT":
      if (ev.t === "AMOUNT_RECORDED") return { s: "THINKING", recipient: st.recipient, tries: st.tries };
      return st;

    case "THINKING":
      if (ev.t === "AMOUNT_HEARD") {
        const qr = st.recipient.kind === "address" ? st.recipient.amount : undefined;
        if (qr !== undefined && !sameAmount(qr, ev.intent.amount)) return cancel("Amount doesn't match the QR");
        // Private recipients: stay here holding the intent; the controller follows with QUOTE_START.
        if (needsQuote(st.recipient)) return { ...st, intent: ev.intent };
        return { s: "POLICY", recipient: st.recipient, intent: ev.intent };
      }
      if (ev.t === "QUOTE_START" && st.intent && needsQuote(st.recipient)) {
        return { s: "QUOTING", recipient: st.recipient, intent: st.intent, startedAt: ev.now };
      }
      if (ev.t === "AMOUNT_REFUSED") {
        if (st.tries < PAY_LIMITS.amountTries) return { s: "LISTENING_AMOUNT", recipient: st.recipient, tries: st.tries + 1 };
        return cancel("Didn't catch an amount");
      }
      return st;

    case "QUOTING":
      if (ev.t === "QUOTE_VERIFIED") {
        return {
          s: "POLICY",
          recipient: {
            kind: "private",
            via: st.recipient.kind,
            peerId: st.recipient.peerId,
            destination: ev.destination,
            tier: ev.tier,
          },
          intent: st.intent,
        };
      }
      if (ev.t === "QUOTE_FAILED") return { s: "NO_VERIFIED_RECIPIENT", reason: ev.reason };
      return st;

    case "POLICY":
      if (ev.t === "POLICY") {
        if (ev.decision === "allow") return st; // the controller follows with CONFIRM_START (fresh code)
        if (ev.decision === "needs_approval")
          return { s: "NEEDS_APPROVAL", recipient: st.recipient, intent: st.intent, reason: ev.reason ?? "over a cap" };
        return cancel(`Policy: ${ev.reason ?? "denied"}`);
      }
      if (ev.t === "CONFIRM_START") {
        return {
          s: "CONFIRMING",
          recipient: st.recipient,
          intent: st.intent,
          code: ev.code,
          startedAt: ev.now,
          voiceTries: 1,
          phase: "listening",
        };
      }
      return st;

    case "NEEDS_APPROVAL":
      // Approved -> back to POLICY; the controller follows with CONFIRM_START (the spoken confirm still runs).
      if (ev.t === "APPROVAL_RESULT") {
        return ev.approved
          ? { s: "POLICY", recipient: st.recipient, intent: st.intent }
          : cancel(`Approval denied${ev.reason ? ` (${ev.reason})` : ""}`);
      }
      return st;

    case "CONFIRMING": {
      if (ev.t === "TICK" && ev.now - st.startedAt >= PAY_LIMITS.confirmMs) return cancel("Confirm timed out");
      if (ev.t === "CONFIRM_RECORDED" && st.phase === "listening") return { ...st, phase: "checking" };
      if (ev.t === "CONFIRM_RESULT" && st.phase === "checking") {
        if (ev.match === "confirmed") return { s: "PAYING", recipient: st.recipient, intent: st.intent };
        if (ev.match === "cancelled") return cancel("Cancelled by voice");
        if (st.voiceTries < PAY_LIMITS.confirmVoiceTries) return { ...st, voiceTries: st.voiceTries + 1, phase: "listening" };
        return { ...st, phase: "tap" };
      }
      if (ev.t === "CONFIRM_TAP" && st.phase === "tap") return { s: "PAYING", recipient: st.recipient, intent: st.intent };
      return st;
    }

    case "PAYING":
      if (ev.t === "PAID") return { s: "PAID", recipient: st.recipient, intent: st.intent, txHash: ev.txHash };
      return st;

    default:
      return st;
  }
}

/** Decimal string equality ("2" == "2.0" == "2.000000"). */
export function sameAmount(a: string, b: string): boolean {
  const norm = (x: string) => {
    const [i = "0", f = ""] = x.trim().split(".");
    return `${BigInt(i || "0")}.${f.replace(/0+$/, "")}`;
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- voice activity detection (pure)

export const VAD = {
  /** RMS (0..1) above this counts as speech. */
  threshold: 0.02,
  /** Stop after this much quiet once speech started. */
  silenceMs: 2_000,
  /** Never record longer than this (invariant 8). */
  maxMs: 8_000,
  /** If nobody speaks at all, give up after this. */
  noSpeechMs: 5_000,
} as const;

export type VadState = { startedAt: number; speechAt: number | null; lastLoudAt: number | null };
export type VadVerdict = "continue" | "stop_silence" | "stop_max" | "stop_no_speech";

export function vadInit(now: number): VadState {
  return { startedAt: now, speechAt: null, lastLoudAt: null };
}

export function vadStep(st: VadState, rms: number, now: number, cfg: typeof VAD = VAD): [VadState, VadVerdict] {
  let next = st;
  if (rms >= cfg.threshold) next = { ...st, speechAt: st.speechAt ?? now, lastLoudAt: now };
  if (now - next.startedAt >= cfg.maxMs) return [next, "stop_max"];
  if (next.speechAt === null) return [next, now - next.startedAt >= cfg.noSpeechMs ? "stop_no_speech" : "continue"];
  if (next.lastLoudAt !== null && now - next.lastLoudAt >= cfg.silenceMs) return [next, "stop_silence"];
  return [next, "continue"];
}
