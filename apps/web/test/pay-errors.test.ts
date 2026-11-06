import { describe, expect, it, vi } from "vitest";
import { micErrorText, sendFailure, TimeoutError, withTimeout } from "../lib/pay-errors.js";

const named = (name: string, message = name, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });

describe("micErrorText", () => {
  it("turns getUserMedia errors into short next steps", () => {
    expect(micErrorText(new DOMException("denied", "NotAllowedError"))).toBe("Microphone blocked: allow it for this site");
    expect(micErrorText(named("NotFoundError"))).toMatch(/No microphone/);
    expect(micErrorText(named("NotReadableError"))).toMatch(/busy/);
    expect(micErrorText(new Error("weird"))).toBe("Microphone error: weird");
  });
});

describe("sendFailure (never claim nothing was paid when it may have)", () => {
  it("errors before anything was sent are plain failures", () => {
    expect(sendFailure(new Error("wallet: bad recipient address"))).toEqual({ maybeSent: false, reason: "Payment failed: wallet: bad recipient address" });
    expect(sendFailure(named("ContractFunctionExecutionError", "x", { shortMessage: "insufficient funds" })).maybeSent).toBe(false);
  });
  it("a reverted tx moved nothing", () => {
    expect(sendFailure(new Error(`wallet: transaction reverted (0x${"a".repeat(64)})`)).maybeSent).toBe(false);
  });
  it("receipt timeouts, a tx hash in the error, or a late Railgun stage are 'unconfirmed'", () => {
    expect(sendFailure(named("WaitForTransactionReceiptTimeoutError")).maybeSent).toBe(true);
    expect(sendFailure(Object.assign(new Error("outer"), { cause: named("TimeoutError") })).maybeSent).toBe(true);
    expect(sendFailure(new Error(`gas drop failed after 0x${"b".repeat(64)}`)).maybeSent).toBe(true);
    expect(sendFailure(new Error("bundler said no"), "submitting").maybeSent).toBe(true);
    expect(sendFailure(new Error("bundler said no"), "confirming").reason).toMatch(/^Payment unconfirmed/);
    expect(sendFailure(new Error("proof failed"), "proving").maybeSent).toBe(false);
  });
});

describe("withTimeout", () => {
  it("rejects with a TimeoutError after the deadline", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => undefined), 1_000, "0G");
    const check = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1_001);
    await check;
    vi.useRealTimers();
  });
  it("passes results through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });
});
