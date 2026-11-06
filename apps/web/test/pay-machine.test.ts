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

describe("scan", () => {
  it("locks a plain address QR", () => {
    expect(run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: addr }]).s).toBe("QR_LOCKED");
  });
  it("CPay QR goes to the honest 'coming next' state, never to pay", () => {
    const st = run([{ t: "SCAN", now: 0 }, { t: "QR_FOUND", recipient: { kind: "cpay", peerId: "p", pub: "x" } }]);
    expect(st.s).toBe("CPAY_PENDING");
    expect(isActive(st)).toBe(false);
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
