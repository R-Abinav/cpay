import { describe, expect, it } from "vitest";
import { ASK_STATUS, payStatus } from "../lib/pay-status.js";
import type { PayState } from "../lib/pay-machine.js";

const o = { privateSend: false, micOn: false };
const r = { kind: "address", address: "0x" + "12".repeat(20) } as const;
const intent = { amount: "2", token: "USDC" };

describe("payStatus", () => {
  it("explains a scan with no QR", () => {
    expect(payStatus({ s: "NO_QR", why: "none" }, o)).toBe("Nothing found to pay. Press Scan to try again.");
  });
  it("never shows the confirm code", () => {
    for (const phase of ["listening", "checking", "tap"] as const) {
      const st: PayState = { s: "CONFIRMING", recipient: r, intent, code: 47, startedAt: 0, voiceTries: 1, phase };
      expect(payStatus(st, o)).not.toMatch(/47/);
      expect(payStatus(st, { ...o, micOn: true })).not.toMatch(/47/);
    }
  });
  it("shortens addresses in failure reasons", () => {
    const a = "0x" + "ab".repeat(20);
    expect(payStatus({ s: "FAILED", reason: `transfer to ${a} reverted` }, o)).not.toContain(a);
  });
  it("private payment: says private, takes minutes, shows elapsed seconds", () => {
    const st: PayState = { s: "PAYING", recipient: r, intent };
    expect(payStatus(st, { privateSend: true, micOn: false, elapsedS: 23 })).toBe("Sending privately… 23 s (takes about 2 minutes).");
    // The toggle alone doesn't make it private: a downgraded payment never claims "privately".
    expect(payStatus(st, { privateSend: false, micOn: false, elapsedS: 3 })).toBe("Sending… 3 s");
  });
  it("every end state says what to do next", () => {
    const ends: PayState[] = [
      { s: "PAID", recipient: r, intent, txHash: "0x1" },
      { s: "CANCELLED", reason: "Stopped" },
      { s: "CANCELLED", reason: "Cancelled by voice" },
      { s: "CANCELLED", reason: "Approval denied (World not linked)" },
      { s: "CANCELLED", reason: "Glasses disconnected" },
      { s: "FAILED", reason: "Payment failed: insufficient funds" },
      { s: "FAILED", reason: "Payment unconfirmed: timed out", maybeSent: true },
      { s: "BRAIN_OFFLINE", detail: "zg_unavailable" },
      { s: "NO_QR", why: "wrong_network" },
      { s: "NO_QR", why: "not_wallet" },
      { s: "NO_MATCH", why: "none" },
      { s: "NO_VERIFIED_RECIPIENT", reason: "no claim" },
    ];
    for (const st of ends) expect(payStatus(st, o)).toMatch(/press Scan|Reconnect|before paying again/i);
  });
  it("nothing-was-paid is never claimed for a payment that may have gone out", () => {
    const st: PayState = { s: "FAILED", reason: "Payment unconfirmed: receipt wait timed out", maybeSent: true };
    expect(payStatus(st, o)).not.toMatch(/Nothing was paid/i);
    expect(payStatus(st, o)).toMatch(/unconfirmed/);
    expect(payStatus({ s: "FAILED", reason: "Payment failed: reverted" }, o)).toMatch(/Nothing was paid/);
  });
  it("shows the want-to-pay ask over an idle or ended stage only", () => {
    expect(payStatus({ s: "IDLE" }, { ...o, ask: "prompting" })).toBe(ASK_STATUS);
    expect(payStatus({ s: "IDLE" }, { ...o, ask: "listening", micOn: true })).toBe(`${ASK_STATUS} Mic on.`);
    expect(payStatus({ s: "PAID", recipient: r, intent, txHash: "0x1" }, { ...o, ask: "checking" })).toBe("Checking your answer…");
    expect(payStatus({ s: "IDLE" }, { ...o, ask: "idle" })).toBe("Press Scan, then look at a QR code or the person you're paying.");
    // A running session always wins (the ask can't run then anyway).
    expect(payStatus({ s: "SCANNING", startedAt: 0, lastUnsupported: null }, { ...o, ask: "prompting" })).toMatch(/Scanning/);
  });
  it("says the same as the voice when the QR locks", () => {
    expect(payStatus({ s: "QR_LOCKED", recipient: r }, o)).toBe("QR code found. Say the amount after the beep.");
  });
});
