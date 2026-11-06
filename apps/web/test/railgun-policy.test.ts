import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  railgunSpendableUSDC: vi.fn(),
  evaluate: vi.fn(),
  loadSettings: vi.fn(),
  spentToday: vi.fn(),
}));

vi.mock("@cpay/wallet", () => mocked);

import { evaluatePolicy } from "../lib/wallet.js";

const wallet = { address: "0x0000000000000000000000000000000000000001" as const };
const recipient = { kind: "address" as const, address: "0x0000000000000000000000000000000000000002" };

describe("Railgun-aware payment policy input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadSettings.mockResolvedValue({ paymentCapUsdc: "5", dailyCapUsdc: "15", allowedTokens: ["USDC"] });
    mocked.spentToday.mockResolvedValue("0");
    mocked.evaluate.mockImplementation((_payment, _recipient, _settings, _spent, balance) => {
      if (!balance) return { decision: "deny", reason: "unknown_balance" };
      return balance.usdc >= 1_000_000n ? { decision: "allow" } : { decision: "deny", reason: "insufficient_balance" };
    });
  });

  it("allows a payment covered by a fresh spendable Railgun balance, regardless of agent USDC", async () => {
    mocked.railgunSpendableUSDC.mockResolvedValue({ balance: 2_000_000n, scannedAt: Date.now() });
    const result = await evaluatePolicy({ wallet, amount: "1", token: "USDC", recipient });
    expect(result.decision).toBe("allow");
    expect(mocked.evaluate.mock.calls[0]?.[4]).toEqual({ usdc: 2_000_000n });
  });

  it("denies when the spendable Railgun balance is below the payment", async () => {
    mocked.railgunSpendableUSDC.mockResolvedValue({ balance: 0n, scannedAt: Date.now() });
    const result = await evaluatePolicy({ wallet, amount: "1", token: "USDC", recipient });
    expect(result).toEqual({ decision: "deny", reason: "insufficient_balance" });
  });

  it("fails closed when no completed scan exists or the scan is older than 60 seconds", async () => {
    mocked.railgunSpendableUSDC.mockResolvedValueOnce(null).mockResolvedValueOnce({ balance: 2_000_000n, scannedAt: Date.now() - 60_001 });
    const missing = await evaluatePolicy({ wallet, amount: "1", token: "USDC", recipient });
    const stale = await evaluatePolicy({ wallet, amount: "1", token: "USDC", recipient });
    expect(missing).toEqual({ decision: "deny", reason: "unknown_balance" });
    expect(stale).toEqual({ decision: "deny", reason: "unknown_balance" });
  });
});
