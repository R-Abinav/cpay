import { describe, expect, it } from "vitest";
import {
  PAY_LIMITS,
  VAD,
  initialPayState,
  isActive,
  payReducer,
  sameAmount,
  vadInit,
  vadStep,
  type PayEvent,
  type PayState,
  type Recipient,
} from "../lib/pay-machine.js";

const addr: Recipient = { kind: "address", address: "0x1111111111111111111111111111111111111111" };
const run = (events: PayEvent[], from: PayState = initialPayState) => events.reduce(payReducer, from);
const toPolicy: PayEvent[] = [
  { t: "SCAN", now: 0 },
  { t: "QR_FOUND", recipient: addr },
  { t: "AMOUNT_LISTEN" },
  { t: "AMOUNT_RECORDED" },
  { t: "AMOUNT_HEARD", intent: { amount: "2", token: "USDC" } },
];
const toConfirm: PayEvent[] = [...toPolicy, { t: "POLICY", decision: "allow" }, { t: "CONFIRM_START", code: 47, now: 1000 }];
const unclearOnce: PayEvent[] = [{ t: "CONFIRM_RECORDED" }, { t: "CONFIRM_RESULT", match: "unclear" }];
const cpay: Recipient = { kind: "cpay", peerId: "peer-1", pub: "a".repeat(64) };
const NONCE = "b".repeat(64);
const DEST = "0x2222222222222222222222222222222222222222";
const matched: PayEvent[] = [
  { t: "SCAN", now: 0 },
  { t: "FACE_PROBED", now: 100 },
  { t: "MATCH_RESULT", result: { ok: true, peerId: "peer-2", pub: "c".repeat(64), matchSecret: NONCE } },
];
const heard: PayEvent[] = [
  { t: "AMOUNT_LISTEN" },
  { t: "AMOUNT_RECORDED" },
  { t: "AMOUNT_HEARD", intent: { amount: "2", token: "USDC" } },
];

describe("face match (pay protocol v2 round 1)", () => {
  it("a stable face moves SCANNING to MATCHING", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "FACE_PROBED", now: 100 }]);
    expect(st).toEqual({ s: "MATCHING", startedAt: 100 });
    expect(isActive(st)).toBe(true);
  });
  it("exactly one match locks the face recipient with its nonce", () => {
    expect(run(matched)).toEqual({
      s: "QR_LOCKED",
      recipient: { kind: "face", peerId: "peer-2", pub: "c".repeat(64), matchSecret: NONCE },
    });
  });
  it("no match -> NO_MATCH, retryable with one tap", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "FACE_PROBED", now: 1 }, { t: "MATCH_RESULT", result: { ok: false, reason: "none", count: 0 } }]);
    expect(st).toEqual({ s: "NO_MATCH", why: "none" });
    expect(isActive(st)).toBe(false);
    expect(payReducer(st, { t: "SCAN", now: 9 }).s).toBe("SCANNING");
  });
  it("two matches abort (never guess between people)", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "FACE_PROBED", now: 1 }, { t: "MATCH_RESULT", result: { ok: false, reason: "multiple", count: 2 } }]);
    expect(st.s).toBe("CANCELLED");
  });
  it("a QR seen first wins: a later face probe is ignored", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: addr }, { t: "FACE_PROBED", now: 5 }]);
    expect(st.s).toBe("QR_LOCKED");
  });
  it("a QR result while MATCHING is ignored", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "FACE_PROBED", now: 1 }, { t: "QR_FOUND", recipient: addr }]);
    expect(st.s).toBe("MATCHING");
  });
  it("Stop cancels matching", () => {
    expect(run([{ t: "SCAN", now: 0 }, { t: "FACE_PROBED", now: 1 }, { t: "STOP" }]).s).toBe("CANCELLED");
  });
});

describe("quote (pay protocol v2 round 2)", () => {
  it("face: amount -> QUOTING -> verified -> POLICY with the one-time destination", () => {
    const thinking = run([...matched, ...heard]);
    expect(thinking.s).toBe("THINKING");
    const q = payReducer(thinking, { t: "QUOTE_START", now: 500 });
    expect(q.s).toBe("QUOTING");
    const p = payReducer(q, { t: "QUOTE_VERIFIED", destination: DEST, tier: "orb" });
    expect(p).toEqual({
      s: "POLICY",
      recipient: { kind: "private", via: "face", peerId: "peer-2", destination: DEST, tier: "orb" },
      intent: { amount: "2", token: "USDC" },
    });
  });
  it("CPay QR goes straight to QUOTE after the amount", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: cpay }, ...heard, { t: "QUOTE_START", now: 1 }]);
    expect(st.s).toBe("QUOTING");
    const p = payReducer(st, { t: "QUOTE_VERIFIED", destination: DEST, tier: "device" });
    expect(p.s === "POLICY" && p.recipient.kind === "private" && p.recipient.via).toBe("cpay");
  });
  it("a plain address never quotes", () => {
    const st = run([...toPolicy, { t: "QUOTE_START", now: 1 }]);
    expect(st.s).toBe("POLICY");
    expect(payReducer(run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: addr }, ...heard]), { t: "QUOTE_START", now: 1 }).s).toBe(
      "POLICY",
    );
  });
  it("QUOTE_START before an amount is ignored", () => {
    expect(run([...matched, { t: "QUOTE_START", now: 1 }]).s).toBe("QR_LOCKED");
  });
  it("no or bad claim -> NO_VERIFIED_RECIPIENT (nothing paid, not active)", () => {
    const st = run([...matched, ...heard, { t: "QUOTE_START", now: 1 }, { t: "QUOTE_FAILED", reason: "timeout" }]);
    expect(st).toEqual({ s: "NO_VERIFIED_RECIPIENT", reason: "timeout" });
    expect(isActive(st)).toBe(false);
  });
  it("Stop cancels while quoting", () => {
    expect(run([...matched, ...heard, { t: "QUOTE_START", now: 1 }, { t: "STOP" }]).s).toBe("CANCELLED");
  });
});

describe("scan", () => {
  it("locks a plain address QR", () => {
    expect(run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: addr }]).s).toBe("QR_LOCKED");
  });
  it("CPay QR locks and then needs a verified quote before policy", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: cpay }]);
    expect(st).toEqual({ s: "QR_LOCKED", recipient: cpay });
    expect(isActive(st)).toBe(true);
  });
  it("times out after the scan window and reports the last unsupported QR", () => {
    expect(run([{ t: "SCAN", now: 0 }, { t: "TICK", now: PAY_LIMITS.scanMs - 1 }]).s).toBe("SCANNING");
    expect(run([{ t: "SCAN", now: 0 }, { t: "TICK", now: PAY_LIMITS.scanMs }])).toEqual({ s: "NO_QR", why: "none" });
    expect(run([{ t: "SCAN", now: 0 }, { t: "QR_UNSUPPORTED", why: "wrong_network" }, { t: "SCAN_TIMEOUT" }])).toEqual({
      s: "NO_QR",
      why: "wrong_network",
    });
  });
  it("accepts a QR during the re-aim grace and retries with one tap", () => {
    const miss = run([{ t: "SCAN", now: 0 }, { t: "SCAN_TIMEOUT" }]);
    expect(payReducer(miss, { t: "QR_FOUND", recipient: addr }).s).toBe("QR_LOCKED");
    expect(payReducer(miss, { t: "SCAN", now: 5 }).s).toBe("SCANNING");
  });
  it("Stop cancels anytime", () => {
    expect(run([{ t: "SCAN", now: 0 }, { t: "STOP" }]).s).toBe("CANCELLED");
  });
  it("Scan is ignored while a session is running", () => {
    const st = run(toPolicy);
    expect(payReducer(st, { t: "SCAN", now: 9 })).toBe(st);
  });
});

describe("amount", () => {
  it("refusal retries once then cancels", () => {
    const base: PayEvent[] = [{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: addr }, { t: "AMOUNT_LISTEN" }, { t: "AMOUNT_RECORDED" }];
    const once = run([...base, { t: "AMOUNT_REFUSED" }]);
    expect(once).toMatchObject({ s: "LISTENING_AMOUNT", tries: 2 });
    const twice = run([{ t: "AMOUNT_RECORDED" }, { t: "AMOUNT_REFUSED" }], once);
    expect(twice.s).toBe("CANCELLED");
  });
  it("brain offline is a visible safe-stop", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: addr }, { t: "AMOUNT_LISTEN" }, { t: "AMOUNT_RECORDED" }, { t: "BRAIN_OFFLINE", detail: "503" }]);
    expect(st.s).toBe("BRAIN_OFFLINE");
  });
  it("EIP-681 amount must equal the spoken amount", () => {
    const withAmount: Recipient = { ...addr, amount: "3" };
    const st = run([
      { t: "SCAN", now: 0 },
      { t: "QR_FOUND", recipient: withAmount },
      { t: "AMOUNT_LISTEN" },
      { t: "AMOUNT_RECORDED" },
      { t: "AMOUNT_HEARD", intent: { amount: "2", token: "USDC" } },
    ]);
    expect(st).toEqual({ s: "CANCELLED", reason: "Amount doesn't match the QR" });
    expect(sameAmount("2", "2.000")).toBe(true);
    expect(sameAmount("2.5", "2.50")).toBe(true);
    expect(sameAmount("2", "20")).toBe(false);
  });
});

describe("policy", () => {
  it("needs_approval stops at APPROVE ON PHONE; deny cancels", () => {
    expect(run([...toPolicy, { t: "POLICY", decision: "needs_approval", reason: "over cap" }]).s).toBe("NEEDS_APPROVAL");
    expect(run([...toPolicy, { t: "POLICY", decision: "deny", reason: "balance" }])).toEqual({ s: "CANCELLED", reason: "Policy: balance" });
  });

  it("a verified Agent Pass approval goes back to POLICY, then the spoken confirm still runs", () => {
    const toApproval: PayEvent[] = [...toPolicy, { t: "POLICY", decision: "needs_approval", reason: "over cap" }];
    const approved = run([...toApproval, { t: "APPROVAL_RESULT", approved: true }]);
    expect(approved.s).toBe("POLICY");
    expect(run([{ t: "CONFIRM_START", code: 12, now: 1 }], approved).s).toBe("CONFIRMING");
  });

  it("a denied / cancelled / expired approval cancels with nothing paid", () => {
    const toApproval: PayEvent[] = [...toPolicy, { t: "POLICY", decision: "needs_approval", reason: "over cap" }];
    expect(run([...toApproval, { t: "APPROVAL_RESULT", approved: false, reason: "denied: access_denied" }])).toEqual({
      s: "CANCELLED",
      reason: "Approval denied (denied: access_denied)",
    });
    expect(run([...toApproval, { t: "STOP" }]).s).toBe("CANCELLED");
    // An approval result outside NEEDS_APPROVAL changes nothing.
    expect(run([...toPolicy, { t: "APPROVAL_RESULT", approved: true }]).s).toBe("POLICY");
  });
});

describe("confirm", () => {
  it("confirmed pays", () => {
    const st = run([...toConfirm, { t: "CONFIRM_RECORDED" }, { t: "CONFIRM_RESULT", match: "confirmed" }]);
    expect(st.s).toBe("PAYING");
    expect(run([{ t: "PAID", txHash: "0xabc" }], st).s).toBe("PAID");
  });
  it("cancel word cancels", () => {
    expect(run([...toConfirm, { t: "CONFIRM_RECORDED" }, { t: "CONFIRM_RESULT", match: "cancelled" }]).s).toBe("CANCELLED");
  });
  it("unclear asks again once, then offers the tap fallback", () => {
    const again = run([...toConfirm, ...unclearOnce]);
    expect(again).toMatchObject({ s: "CONFIRMING", voiceTries: 2, phase: "listening", code: 47 });
    const tap = run(unclearOnce, again);
    expect(tap).toMatchObject({ s: "CONFIRMING", phase: "tap" });
    expect(payReducer(tap, { t: "CONFIRM_TAP" }).s).toBe("PAYING");
  });
  it("tap is ignored before the fallback is offered", () => {
    const st = run(toConfirm);
    expect(payReducer(st, { t: "CONFIRM_TAP" })).toBe(st);
  });
  it("whole confirm step is limited to 60 s", () => {
    const st = run(toConfirm);
    expect(payReducer(st, { t: "TICK", now: 1000 + PAY_LIMITS.confirmMs - 1 }).s).toBe("CONFIRMING");
    expect(payReducer(st, { t: "TICK", now: 1000 + PAY_LIMITS.confirmMs })).toEqual({ s: "CANCELLED", reason: "Confirm timed out" });
  });
  it("Stop after payment never undoes PAID", () => {
    const paid = run([...toConfirm, { t: "CONFIRM_RECORDED" }, { t: "CONFIRM_RESULT", match: "confirmed" }, { t: "PAID", txHash: "0x1" }]);
    expect(payReducer(paid, { t: "STOP" })).toBe(paid);
    const paying = run([...toConfirm, { t: "CONFIRM_RECORDED" }, { t: "CONFIRM_RESULT", match: "confirmed" }]);
    expect(payReducer(paying, { t: "STOP" })).toBe(paying);
  });
});

describe("vad", () => {
  it("stops after silence once speech started", () => {
    let st = vadInit(0);
    let v;
    [st, v] = vadStep(st, 0.1, 100);
    expect(v).toBe("continue");
    [st, v] = vadStep(st, 0.001, 100 + VAD.silenceMs - 1);
    expect(v).toBe("continue");
    [st, v] = vadStep(st, 0.001, 100 + VAD.silenceMs);
    expect(v).toBe("stop_silence");
  });
  it("gives up without speech and caps at 6 s", () => {
    expect(vadStep(vadInit(0), 0, VAD.noSpeechMs)[1]).toBe("stop_no_speech");
    let st = vadInit(0);
    for (let t = 0; t < VAD.maxMs; t += 100) st = vadStep(st, 0.5, t)[0];
    expect(vadStep(st, 0.5, VAD.maxMs)[1]).toBe("stop_max");
  });
});
