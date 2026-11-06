import { describe, expect, it } from "vitest";
import { DEFAULT_GAS_DROP_WEI, parseGasDropWei } from "../lib/public-config.js";

describe("parseGasDropWei", () => {
  it("defaults to 0.0005 ETH when unset, empty or invalid", () => {
    expect(DEFAULT_GAS_DROP_WEI).toBe(500_000_000_000_000n);
    for (const v of [undefined, "", "  ", "abc", "-1", "1e15", "0.1"]) expect(parseGasDropWei(v)).toBe(DEFAULT_GAS_DROP_WEI);
  });
  it("never allows 0 (a one-time address without gas can't move its funds)", () => {
    expect(parseGasDropWei("0")).toBe(DEFAULT_GAS_DROP_WEI);
  });
  it("uses a positive configured value", () => {
    expect(parseGasDropWei("700000000000000")).toBe(700_000_000_000_000n);
  });
});
