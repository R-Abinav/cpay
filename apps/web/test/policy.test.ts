import { describe, expect, it } from "vitest";
import {
  dayKey,
  emptyLedger,
  evaluatePolicy,
  hasPaidSession,
  recordSpend,
  spentToday,
  type PolicyConfig,
  type PolicyInput,
} from "../lib/policy.js";
import { findToken, formatAmount, knownTokens, parseAmount } from "../lib/units.js";

const USDC = 1_000_000n;
const cfg: PolicyConfig = { allowedTokens: ["USDC"], paymentCap: 5n * USDC, dailyCap: 15n * USDC };
const base: PolicyInput = {
  amount: 2n * USDC,
  token: "USDC",
  spentToday: 0n,
  tokenBalance: 20n * USDC,
  ethBalance: 10n ** 16n,
  gasDropWei: 3n * 10n ** 14n,
};

describe("evaluatePolicy", () => {
  it("allows a small payment", () => {
    expect(evaluatePolicy(cfg, base).decision).toBe("allow");
  });

  it("allows exactly the per-payment cap", () => {
    expect(evaluatePolicy(cfg, { ...base, amount: 5n * USDC }).decision).toBe("allow");
  });

  it("needs approval over the per-payment cap (8 USDC demo)", () => {
    const r = evaluatePolicy(cfg, { ...base, amount: 8n * USDC });
    expect(r.decision).toBe("needs_approval");
    expect(r.overPaymentCap).toBe(true);
    expect(r.overDailyCap).toBe(false);
  });

  it("needs approval past the daily cap even under the per-payment cap", () => {
    const r = evaluatePolicy(cfg, { ...base, amount: 4n * USDC, spentToday: 12n * USDC });
    expect(r.decision).toBe("needs_approval");
    expect(r.overDailyCap).toBe(true);
  });

  it("denies tokens outside the allow-list, case-insensitively matching symbols", () => {
    expect(evaluatePolicy(cfg, { ...base, token: "DAI" }).decision).toBe("deny");
    expect(evaluatePolicy(cfg, { ...base, token: "usdc" }).decision).toBe("allow");
  });

  it("denies non-positive amounts", () => {
    expect(evaluatePolicy(cfg, { ...base, amount: 0n }).decision).toBe("deny");
  });

  it("balance is the hard ceiling: over cap AND over balance is deny, not approval", () => {
    const r = evaluatePolicy(cfg, { ...base, amount: 8n * USDC, tokenBalance: 7n * USDC });
    expect(r.decision).toBe("deny");
  });

  it("fails closed when balances are unknown", () => {
    expect(evaluatePolicy(cfg, { ...base, tokenBalance: null }).decision).toBe("deny");
    expect(evaluatePolicy(cfg, { ...base, ethBalance: null }).decision).toBe("deny");
  });

  it("denies when ETH can't cover the gas drop", () => {
    expect(evaluatePolicy(cfg, { ...base, ethBalance: 3n * 10n ** 14n }).decision).toBe("deny");
  });
});

describe("ledger", () => {
  it("accumulates per day and resets on a new day", () => {
    let l = emptyLedger("2026-11-06");
    l = recordSpend(l, { sessionId: "a", token: "usdc", amount: "2000000", txHash: "0x1", at: "t" }, "2026-11-06");
    l = recordSpend(l, { sessionId: "b", token: "USDC", amount: "3000000", txHash: "0x2", at: "t" }, "2026-11-06");
    expect(spentToday(l, "USDC", "2026-11-06")).toBe(5n * USDC);
    expect(spentToday(l, "USDC", "2026-11-07")).toBe(0n);
    l = recordSpend(l, { sessionId: "c", token: "USDC", amount: "1000000", txHash: "0x3", at: "t" }, "2026-11-07");
    expect(spentToday(l, "USDC", "2026-11-07")).toBe(USDC);
    expect(hasPaidSession(l, "a")).toBe(true);
    expect(hasPaidSession(l, "z")).toBe(false);
  });

  it("formats local day keys", () => {
    expect(dayKey(new Date(2026, 10, 6, 23, 59))).toBe("2026-11-06");
  });
});

describe("units", () => {
  it("parses decimals exactly", () => {
    expect(parseAmount("2", 6)).toBe(2_000_000n);
    expect(parseAmount("2.5", 6)).toBe(2_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("8.000", 6)).toBe(8_000_000n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["-1", "1e6", "0x10", "", "1.0000001", "01", "1,5", "Infinity"]) {
      expect(() => parseAmount(bad, 6)).toThrow();
    }
  });

  it("formats base units", () => {
    expect(formatAmount(2_500_000n, 6)).toBe("2.5");
    expect(formatAmount(8_000_000n, 6)).toBe("8");
  });

  it("finds tokens by symbol or address", () => {
    const t = knownTokens("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
    expect(findToken(t, "usdc")?.decimals).toBe(6);
    expect(findToken(t, "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238")?.symbol).toBe("USDC");
    expect(findToken(t, "DAI")).toBeNull();
  });
});
