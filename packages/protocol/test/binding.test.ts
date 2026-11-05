import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bindingDigest, bindingDigestHex, bytesToHex, lp, type BindingFields } from "../src/index.js";

const base: BindingFields = {
  sessionNonce: "ab".repeat(32),
  destination: "0x00000000000000000000000000000000000000Aa",
  chainId: 11155111,
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  amount: 2_000_000n,
};

// Stand-in for the credential verifier: a proof is "valid" iff its bound digest equals the recomputed one.
const verify = (boundTo: string, fields: BindingFields) => bindingDigestHex(fields) === boundTo;

describe("bindingDigest", () => {
  it("matches the spec layout exactly", () => {
    const expected = sha256(
      concatBytes(
        utf8ToBytes("cpay/v1/binding"),
        lp(base.sessionNonce),
        lp((base.destination as string).toLowerCase()),
        lp("11155111"),
        lp(base.token.toLowerCase()),
        lp("2000000"),
      ),
    );
    expect(bytesToHex(bindingDigest(base))).toBe(bytesToHex(expected));
  });

  it("lp is a 4-byte big-endian length prefix", () => {
    expect(Array.from(lp("abc"))).toEqual([0, 0, 0, 3, 97, 98, 99]);
  });

  it("is case-insensitive on addresses and type-insensitive on numbers", () => {
    const d = bindingDigestHex(base);
    expect(bindingDigestHex({ ...base, destination: base.destination.toLowerCase(), token: base.token.toUpperCase().replace("0X", "0x") })).toBe(d);
    expect(bindingDigestHex({ ...base, chainId: 11155111n, amount: "2000000" })).toBe(d);
  });

  const tampers: [string, Partial<BindingFields>][] = [
    ["sessionNonce", { sessionNonce: "ab".repeat(31) + "ac" }],
    ["destination", { destination: "0x00000000000000000000000000000000000000ab" }],
    ["chainId", { chainId: 1 }],
    ["token", { token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7239" }],
    ["amount", { amount: 2_000_001n }],
  ];
  for (const [field, patch] of tampers) {
    it(`changing ${field} breaks verification`, () => {
      const bound = bindingDigestHex(base);
      expect(verify(bound, base)).toBe(true);
      expect(verify(bound, { ...base, ...patch })).toBe(false);
    });
  }

  it("length-prefixing prevents field-boundary shifting", () => {
    // Without lp, moving a digit from chainId into amount could collide.
    const a = bindingDigestHex({ ...base, chainId: 12, amount: "3" });
    const b = bindingDigestHex({ ...base, chainId: 1, amount: "23" });
    expect(a).not.toBe(b);
  });

  it("rejects non-canonical input", () => {
    expect(() => bindingDigest({ ...base, amount: "02" })).toThrow();
    expect(() => bindingDigest({ ...base, amount: "-1" })).toThrow();
    expect(() => bindingDigest({ ...base, sessionNonce: "AB".repeat(32) })).toThrow();
    expect(() => bindingDigest({ ...base, destination: "0x1234" })).toThrow();
    expect(() => bindingDigest({ ...base, chainId: 1.5 })).toThrow();
  });
});
