import { describe, expect, it } from "vitest";
import { FEE_RESERVE_WEI, canPayFrom, grossOf, privateNeeds } from "../src/needs.js";
import type { PrivateBalances } from "../src/types.js";

const bal = (usdc: bigint, weth: bigint, pending = 0n): PrivateBalances => ({
  usdc: { valid: usdc, pending },
  weth: { valid: weth, pending },
});
const DROP = 500_000_000_000_000n;

describe("private payment needs", () => {
  it("adds the 0.25% unshield fee on top (same as Kohaku)", () => {
    expect(grossOf(200_000n)).toBe(200_501n);
    expect(grossOf(1_000_000n)).toBe(1_002_506n);
  });

  it("WETH covers the fee reserve, plus the gross gas drop when asked", () => {
    expect(privateNeeds({ amount: 200_000n })).toEqual({ usdc: 200_501n, weth: FEE_RESERVE_WEI });
    expect(privateNeeds({ amount: 200_000n, gasDropWei: DROP }).weth).toBe(FEE_RESERVE_WEI + grossOf(DROP));
  });

  it("rejects bad input", () => {
    expect(() => privateNeeds({ amount: 0n })).toThrow();
    expect(() => privateNeeds({ amount: 1n, gasDropWei: -1n })).toThrow();
  });

  it("uses only POI-valid balances", () => {
    const n = privateNeeds({ amount: 200_000n, gasDropWei: DROP });
    expect(canPayFrom(bal(n.usdc, n.weth), n)).toEqual({ ok: true });
    // exactly the net amount is not enough: the fee is on top
    expect(canPayFrom(bal(200_000n, n.weth), n)).toEqual({ ok: false, reason: "usdc" });
    // WETH for the fee but not for the gas drop
    expect(canPayFrom(bal(n.usdc, FEE_RESERVE_WEI), n)).toEqual({ ok: false, reason: "weth" });
    // pending never counts
    expect(canPayFrom(bal(0n, 0n, 10n ** 30n), n)).toEqual({ ok: false, reason: "usdc" });
  });
});
