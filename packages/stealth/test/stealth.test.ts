import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddressEqual } from "viem";
import {
  KEY_DERIVATION_MESSAGE,
  createOneTimeDestination,
  keysFromSeed,
  keysFromSignature,
  ownsDestination,
  recoverSpendKey,
} from "../src/index.js";

async function keysFor(pk = generatePrivateKey()) {
  const sig = await privateKeyToAccount(pk).signMessage({ message: KEY_DERIVATION_MESSAGE });
  return keysFromSignature(sig);
}

describe("stealth keys + one-time destinations", () => {
  it("derives keys deterministically from the wallet signature", async () => {
    const pk = generatePrivateKey();
    const a = await keysFor(pk);
    const b = await keysFor(pk);
    expect(a).toEqual(b);
    expect(a.metaAddressURI).toMatch(/^st:eth:0x[0-9a-f]{132}$/);
    expect(a.metaAddressURI).toBe(`st:eth:${a.spendingPublicKey}${a.viewingPublicKey.slice(2)}`);
  });

  it("keysFromSeed matches keysFromSignature's shape and owns its destinations", () => {
    const spend = new Uint8Array(32).fill(7);
    const view = new Uint8Array(32).fill(9);
    const a = keysFromSeed(spend, view);
    const b = keysFromSeed(`0x${"07".repeat(32)}`, `0x${"09".repeat(32)}`);
    expect(a).toEqual(b);
    expect(a.spendingPrivateKey).toBe(`0x${"07".repeat(32)}`);
    expect(a.spendingPublicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
    expect(a.metaAddressURI).toBe(`st:eth:${a.spendingPublicKey}${a.viewingPublicKey.slice(2)}`);
    const d = createOneTimeDestination(a);
    expect(ownsDestination(a, d)).toBe(true);
    expect(isAddressEqual(privateKeyToAccount(recoverSpendKey(a, d)).address, d.address)).toBe(true);
  });

  it("keysFromSeed rejects zero, out-of-range and short keys", () => {
    const ok = new Uint8Array(32).fill(1);
    expect(() => keysFromSeed(new Uint8Array(32), ok)).toThrow(/invalid/);
    expect(() => keysFromSeed(ok, new Uint8Array(32).fill(0xff))).toThrow(/invalid/);
    expect(() => keysFromSeed(new Uint8Array(31).fill(1), ok)).toThrow(/invalid/);
  });

  it("rejects a malformed signature", () => {
    expect(() => keysFromSignature("0x1234")).toThrow();
  });

  it("generates a fresh, self-owned destination each time", async () => {
    const k = await keysFor();
    const d1 = createOneTimeDestination(k);
    const d2 = createOneTimeDestination(k);
    expect(d1.address).not.toBe(d2.address);
    expect(d1.ephemeralPublicKey).not.toBe(d2.ephemeralPublicKey);
    expect(ownsDestination(k, d1)).toBe(true);
    expect(ownsDestination(k, d2)).toBe(true);
  });

  it("recovers a spend key that controls exactly the destination", async () => {
    const k = await keysFor();
    const d = createOneTimeDestination(k);
    const sk = recoverSpendKey(k, d);
    expect(isAddressEqual(privateKeyToAccount(sk).address, d.address)).toBe(true);
  });

  it("another recipient's keys neither own nor recover the destination", async () => {
    const alice = await keysFor();
    const bob = await keysFor();
    const d = createOneTimeDestination(alice);
    expect(ownsDestination(bob, d)).toBe(false);
    expect(() => recoverSpendKey(bob, d)).toThrow(/does not control/);
  });

  it("recoverSpendKey throws if the stored address was swapped", async () => {
    const k = await keysFor();
    const d1 = createOneTimeDestination(k);
    const d2 = createOneTimeDestination(k);
    expect(() => recoverSpendKey(k, { ...d1, address: d2.address })).toThrow(/does not control/);
  });
});
