import { describe, expect, it } from "vitest";
import { buildTemplate, cosine, isMatch, l2Normalize } from "../src/index.js";

describe("face matching", () => {
  it("cosine basics", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([3, 4], [6, 8])).toBeCloseTo(1);
  });

  it("cosine rejects length mismatch, zero and non-finite vectors", () => {
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow(/mismatch/);
    expect(() => cosine([0, 0], [1, 0])).toThrow();
    expect(() => cosine([NaN, 0], [1, 0])).toThrow();
  });

  it("buildTemplate is the L2-normalised mean and needs 5+ embeddings", () => {
    expect(() => buildTemplate([[1, 0], [1, 0]])).toThrow();
    const t = buildTemplate([[1, 0], [2, 0], [0, 1], [0, 3], [1, 1]]);
    const n = Math.hypot(...t);
    expect(n).toBeCloseTo(1);
    const expected = l2Normalize([1 + 1 + 0 + 0 + Math.SQRT1_2, 0 + 0 + 1 + 1 + Math.SQRT1_2]);
    expect(t[0]).toBeCloseTo(expected[0]!);
    expect(t[1]).toBeCloseTo(expected[1]!);
    expect(() => buildTemplate([[1, 0], [1, 0], [1, 0], [1, 0], [1, 0, 0]])).toThrow();
  });

  it("isMatch uses threshold 0.6 by default and never matches on length mismatch", () => {
    expect(isMatch([1, 0], [1, 0])).toBe(true);
    expect(isMatch([1, 1], [1, 0])).toBe(true); // cos = 0.707
    expect(isMatch([1, 2], [1, 0])).toBe(false); // cos = 0.447
    expect(isMatch([1, 2], [1, 0], 0.4)).toBe(true);
    expect(isMatch([1, 0], [1, 0, 0])).toBe(false);
  });
});
