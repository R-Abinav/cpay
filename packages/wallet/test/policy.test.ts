import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { defaultSettings, evaluate, loadSettings, recordSpend, saveSettings, settingsRaise, spentToday, type PolicySettings } from "../src/index.js";
import { _resetStorageForTests } from "../src/storage.js";

const TO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as const;
const S: PolicySettings = { paymentCapUsdc: "5", dailyCapUsdc: "15", allowedTokens: ["USDC"] };
const BAL = { usdc: 100_000_000n }; // 100 USDC
const usdc = { token: "USDC" as const };

describe("evaluate", () => {
  it("allows under both caps", () => {
    expect(evaluate({ amount: "2", ...usdc }, { to: TO }, S, "0", BAL)).toEqual({ decision: "allow" });
  });
  it("allows exactly at the payment cap and exactly at the daily cap", () => {
    expect(evaluate({ amount: "5", ...usdc }, { to: TO }, S, "10", BAL)).toEqual({ decision: "allow" });
  });
  it("needs approval over the payment cap", () => {
    expect(evaluate({ amount: "5.000001", ...usdc }, { to: TO }, S, "0", BAL)).toEqual({ decision: "needs_approval", reason: "over_payment_cap" });
  });
  it("needs approval over the daily cap", () => {
    expect(evaluate({ amount: "3", ...usdc }, { to: TO }, S, "12.5", BAL)).toEqual({ decision: "needs_approval", reason: "over_daily_cap" });
  });
  it.each(["0", "-1", "abc", "1.0000001", "1e3", " 1", "", "01"])("denies invalid amount %j", (a) => {
    expect(evaluate({ amount: a, ...usdc }, { to: TO }, S, "0", BAL)).toEqual({ decision: "deny", reason: "invalid_amount" });
  });
  it("denies a token not on the allow-list", () => {
    expect(evaluate({ amount: "1", ...usdc }, { to: TO }, { ...S, allowedTokens: [] }, "0", BAL)).toEqual({ decision: "deny", reason: "token_not_allowed" });
    expect(evaluate({ amount: "1", token: "DAI" as "USDC" }, { to: TO }, S, "0", BAL)).toEqual({ decision: "deny", reason: "token_not_allowed" });
  });
  it("denies a QR amount mismatch, accepts an equal one written differently", () => {
    expect(evaluate({ amount: "2", ...usdc }, { to: TO, qrAmount: "3" }, S, "0", BAL)).toEqual({ decision: "deny", reason: "qr_amount_mismatch" });
    expect(evaluate({ amount: "2", ...usdc }, { to: TO, qrAmount: "2.000" }, S, "0", BAL)).toEqual({ decision: "allow" });
  });
  it("denies on unknown balance", () => {
    expect(evaluate({ amount: "1", ...usdc }, { to: TO }, S, "0", null)).toEqual({ decision: "deny", reason: "unknown_balance" });
  });
  it("denies on insufficient balance, even over a cap", () => {
    expect(evaluate({ amount: "1.5", ...usdc }, { to: TO }, S, "0", { usdc: 1_000_000n })).toEqual({ decision: "deny", reason: "insufficient_balance" });
    expect(evaluate({ amount: "50", ...usdc }, { to: TO }, S, "0", { usdc: 1_000_000n })).toEqual({ decision: "deny", reason: "insufficient_balance" });
  });
  it("fails closed on malformed caps or ledger", () => {
    expect(evaluate({ amount: "1", ...usdc }, { to: TO }, { ...S, paymentCapUsdc: "x" }, "0", BAL)).toEqual({ decision: "needs_approval", reason: "over_payment_cap" });
    expect(evaluate({ amount: "1", ...usdc }, { to: TO }, S, "garbage", BAL)).toEqual({ decision: "needs_approval", reason: "over_daily_cap" });
  });
});

describe("settings", () => {
  beforeEach(async () => {
    await _resetStorageForTests();
    globalThis.indexedDB = new IDBFactory();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults from env", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_PAYMENT_CAP_USDC", "3");
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_DAILY_CAP_USDC", "9.5");
    vi.stubEnv("NEXT_PUBLIC_ALLOWED_TOKENS", "usdc, DAI");
    expect(defaultSettings()).toEqual({ paymentCapUsdc: "3", dailyCapUsdc: "9.5", allowedTokens: ["USDC"] });
  });
  it("falls back to 5 / 15 / USDC when env is missing or bad", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_PAYMENT_CAP_USDC", "lots");
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_DAILY_CAP_USDC", "");
    vi.stubEnv("NEXT_PUBLIC_ALLOWED_TOKENS", "");
    expect(defaultSettings()).toEqual({ paymentCapUsdc: "5", dailyCapUsdc: "15", allowedTokens: ["USDC"] });
  });
  it("loads defaults, then what was saved", async () => {
    expect(await loadSettings()).toEqual(defaultSettings());
    await saveSettings({ paymentCapUsdc: "1", dailyCapUsdc: "2", allowedTokens: ["USDC"] });
    expect(await loadSettings()).toEqual({ paymentCapUsdc: "1", dailyCapUsdc: "2", allowedTokens: ["USDC"] });
  });
  it("refuses invalid settings", async () => {
    await expect(saveSettings({ paymentCapUsdc: "-1", dailyCapUsdc: "2", allowedTokens: ["USDC"] })).rejects.toThrow();
  });
  it("settingsRaise flags loosening only", () => {
    expect(settingsRaise(S, { ...S, paymentCapUsdc: "6" })).toBe(true);
    expect(settingsRaise(S, { ...S, dailyCapUsdc: "20" })).toBe(true);
    expect(settingsRaise(S, { ...S, paymentCapUsdc: "1", dailyCapUsdc: "2" })).toBe(false);
    expect(settingsRaise({ ...S, allowedTokens: [] }, S)).toBe(true);
  });
});

describe("spent-today ledger", () => {
  beforeEach(async () => {
    await _resetStorageForTests();
    globalThis.indexedDB = new IDBFactory();
  });

  it("starts at 0 and adds payments", async () => {
    expect(await spentToday()).toBe("0");
    await recordSpend("2", "0xaa");
    await recordSpend("0.5", "0xbb");
    expect(await spentToday()).toBe("2.5");
  });
  it("counts the same tx hash once", async () => {
    await recordSpend("2", "0xAA");
    await recordSpend("2", "0xaa");
    expect(await spentToday()).toBe("2");
  });
  it("resets on a new local day", async () => {
    const d1 = new Date(2026, 10, 6, 23, 0);
    const d2 = new Date(2026, 10, 7, 0, 1);
    await recordSpend("4", "0x01", d1);
    expect(await spentToday(d1)).toBe("4");
    expect(await spentToday(d2)).toBe("0");
  });
  it("rejects an invalid amount", async () => {
    await expect(recordSpend("nope", "0x01")).rejects.toThrow();
  });
});
