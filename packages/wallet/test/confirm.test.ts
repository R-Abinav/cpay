import { describe, expect, it, vi } from "vitest";
import { matchConfirm, newConfirmCode } from "../src/index.js";

describe("newConfirmCode", () => {
  it("is always an integer in 10..99 and covers the range", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) {
      const c = newConfirmCode();
      expect(Number.isInteger(c) && c >= 10 && c <= 99).toBe(true);
      seen.add(c);
    }
    expect(seen.size).toBe(90);
  });
  it("rejects bytes >= 180 (no modulo bias)", () => {
    const bytes = [255, 180, 179];
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
      a[0] = bytes.shift() ?? 0;
      return a;
    }) as unknown as Crypto["getRandomValues"]);
    expect(newConfirmCode()).toBe(10 + (179 % 90));
    spy.mockRestore();
  });
});

describe("matchConfirm", () => {
  const CODE = 47;
  it.each<[string, "confirmed" | "cancelled" | "unclear"]>([
    ["confirm 47", "confirmed"],
    ["Confirm 47.", "confirmed"],
    ["CONFIRM, 47!", "confirmed"],
    ["confirm forty seven", "confirmed"],
    ["confirm forty-seven", "confirmed"],
    ["Confirm Forty-Seven.", "confirmed"],
    ["confirm four seven", "confirmed"],
    ["confirm 4 7", "confirmed"],
    ["confirm47", "confirmed"],
    ["47 confirm", "confirmed"],
    ["yes confirm 47 please", "confirmed"],
    ["confirmed 47", "confirmed"], // common transcription of "confirm"; accepted (documented)
    ["confirm fourty seven", "confirmed"], // common misspelling
    ["confirm 48", "unclear"],
    ["confirm forty eight", "unclear"],
    ["confirm 74", "unclear"],
    ["confirm 47 48", "unclear"], // a second, different number
    ["confirm 470", "unclear"],
    ["confirm", "unclear"],
    ["47", "unclear"],
    ["forty seven", "unclear"],
    ["confirmation 47", "unclear"],
    ["", "unclear"],
    ["   ", "unclear"],
    ["cancel", "cancelled"],
    ["Cancel that.", "cancelled"],
    ["stop", "cancelled"],
    ["no", "cancelled"],
    ["No, don't.", "cancelled"],
    ["don't confirm 47", "cancelled"],
    ["do not confirm 47", "cancelled"],
    ["confirm 47 no wait stop", "cancelled"],
    ["toString constructor", "unclear"],
  ])("%j -> %s", (t, want) => {
    expect(matchConfirm(t, CODE)).toBe(want);
  });

  it("handles teen and round codes", () => {
    expect(matchConfirm("confirm thirteen", 13)).toBe("confirmed");
    expect(matchConfirm("confirm one three", 13)).toBe("confirmed");
    expect(matchConfirm("confirm twenty", 20)).toBe("confirmed");
    expect(matchConfirm("confirm two zero", 20)).toBe("confirmed");
    expect(matchConfirm("confirm ten", 10)).toBe("confirmed");
    expect(matchConfirm("confirm ninety nine", 99)).toBe("confirmed");
  });
});
