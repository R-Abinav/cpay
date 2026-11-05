import { describe, expect, it } from "vitest";
import { createHash, hkdfSync } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { deriveKeys, INFO, PRF_SALT } from "../src/index.js";

const ROOT = new Uint8Array(32).map((_, i) => i + 1);
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

describe("deriveKeys", () => {
  it("is deterministic per root", () => {
    expect(deriveKeys(ROOT)).toEqual(deriveKeys(new Uint8Array(ROOT)));
  });

  it("pins the agent wallet address for a fixed root", () => {
    const a = privateKeyToAccount(deriveKeys(ROOT).agentPrivateKey);
    expect(a.address).toMatchInlineSnapshot(`"0x4801f8EF8b7B8653e5a590740A39ad5B21dDD12C"`);
  });

  it("matches an independent HKDF-SHA256 + (x mod (n-1)) + 1 computation", () => {
    const okm = Buffer.from(hkdfSync("sha256", ROOT, Buffer.alloc(0), INFO.agentWallet, 48));
    const sk = (BigInt("0x" + okm.toString("hex")) % (N - 1n)) + 1n;
    expect(deriveKeys(ROOT).agentPrivateKey).toBe("0x" + sk.toString(16).padStart(64, "0"));
    const ep = Buffer.from(hkdfSync("sha256", ROOT, Buffer.alloc(0), INFO.episode, 32));
    expect(hex(deriveKeys(ROOT).episodeKey)).toBe(ep.toString("hex"));
  });

  it("gives a different key per info string", () => {
    const k = deriveKeys(ROOT);
    const all = [k.agentPrivateKey.slice(2), hex(k.stealthSpend), hex(k.stealthView), hex(k.bbsHolder), hex(k.bbsBlinding), hex(k.episodeKey)];
    expect(new Set(all).size).toBe(all.length);
    for (const h of all) expect(h).toHaveLength(64);
  });

  it("gives different keys for a different root", () => {
    const other = new Uint8Array(ROOT);
    other[0] = 0xff;
    expect(deriveKeys(other).agentPrivateKey).not.toBe(deriveKeys(ROOT).agentPrivateKey);
  });

  it("rejects a root that is not 32 bytes", () => {
    expect(() => deriveKeys(new Uint8Array(31))).toThrow();
  });

  it("uses sha256('cpay/v1/root') as the PRF salt", () => {
    expect(hex(PRF_SALT)).toBe(createHash("sha256").update("cpay/v1/root").digest("hex"));
  });
});
