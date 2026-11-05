import { describe, expect, it } from "vitest";
import { generateKeyPair, open, openBytes, seal, sealBytes, publicKeyOf } from "../src/index.js";

describe("seal/open", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();

  it("round-trips JSON between two key pairs (both directions derive the same key)", () => {
    const box = seal(a.secretKey, b.publicKey, "probe:s1", { hello: "world", n: 1 });
    expect(open(b.secretKey, a.publicKey, "probe:s1", box)).toEqual({ hello: "world", n: 1 });
  });

  it("uses a fresh 12-byte IV per seal", () => {
    const x = sealBytes(a.secretKey, b.publicKey, "c", new Uint8Array([1, 2, 3]));
    const y = sealBytes(a.secretKey, b.publicKey, "c", new Uint8Array([1, 2, 3]));
    expect(x.iv).not.toEqual(y.iv);
    expect(x.ct).not.toEqual(y.ct);
    expect(atob(x.iv).length).toBe(12);
  });

  it("fails with the wrong context (context is bound via HKDF info and AAD)", () => {
    const box = seal(a.secretKey, b.publicKey, "probe:s1", "x");
    expect(() => open(b.secretKey, a.publicKey, "claim:s1", box)).toThrow();
    expect(() => open(b.secretKey, a.publicKey, "probe:s2", box)).toThrow();
  });

  it("fails with the wrong key", () => {
    const c = generateKeyPair();
    const box = seal(a.secretKey, b.publicKey, "ctx", "x");
    expect(() => open(c.secretKey, a.publicKey, "ctx", box)).toThrow();
    expect(() => open(b.secretKey, c.publicKey, "ctx", box)).toThrow();
  });

  it("fails on a tampered ciphertext or IV", () => {
    const box = sealBytes(a.secretKey, b.publicKey, "ctx", new Uint8Array(32));
    const ct = Uint8Array.from(atob(box.ct), (ch) => ch.charCodeAt(0));
    ct[0]! ^= 1;
    expect(() => openBytes(b.secretKey, a.publicKey, "ctx", { iv: box.iv, ct: btoa(String.fromCharCode(...ct)) })).toThrow();
    const iv = Uint8Array.from(atob(box.iv), (ch) => ch.charCodeAt(0));
    iv[0]! ^= 1;
    expect(() => openBytes(b.secretKey, a.publicKey, "ctx", { iv: btoa(String.fromCharCode(...iv)), ct: box.ct })).toThrow();
  });

  it("rejects bad public keys and empty contexts", () => {
    expect(() => seal(a.secretKey, "00", "ctx", 1)).toThrow();
    expect(() => seal(a.secretKey, "00".repeat(32), "ctx", 1)).toThrow(); // low-order point
    expect(() => seal(a.secretKey, b.publicKey, "", 1)).toThrow();
  });

  it("publicKeyOf matches the generated key", () => {
    expect(publicKeyOf(a.secretKey)).toBe(a.publicKey);
  });
});
