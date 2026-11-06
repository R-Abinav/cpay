import { describe, expect, it } from "vitest";
import { payStatus } from "../lib/pay-status.js";

const o = { privateMode: false, micOn: false };

describe("payStatus", () => {
  it("explains a scan with no QR", () => {
    expect(payStatus({ s: "NO_QR", why: "none" }, o)).toBe("No QR found. Tap Scan to try again.");
  });
  it("never shows the confirm code", () => {
    const st = { s: "CONFIRMING", code: 47, phase: "listening" } as never;
    expect(payStatus(st, o)).not.toMatch(/47/);
  });
  it("shortens addresses in failure reasons", () => {
    const a = "0x" + "ab".repeat(20);
    expect(payStatus({ s: "FAILED", reason: `transfer to ${a} reverted` }, o)).not.toContain(a);
  });
  it("tells a private payment takes minutes", () => {
    expect(payStatus({ s: "PAYING" } as never, { privateMode: true, micOn: false })).toMatch(/2 minutes/);
  });
});
