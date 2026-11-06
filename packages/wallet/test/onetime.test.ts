// One-time destinations (stealth): derivation, persistence and balances, against an in-memory chain.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, isAddressEqual, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ownsDestination, recoverSpendKey } from "@cpay/stealth";
import {
  chainOf,
  deriveKeys,
  deriveStealthKeys,
  listOneTimeDestinations,
  newOneTimeDestination,
  oneTimeBalances,
  type ChainConfig,
} from "../src/index.js";
import { _resetStorageForTests, kvGet } from "../src/storage.js";
import { fakeChain } from "./fakechain.js";

const USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const cfg: ChainConfig = { chainId: 11155111, rpcUrl: "http://fake.invalid", usdc: USDC, explorerUrl: "https://x.invalid" };
const root = new Uint8Array(32).map((_, i) => i + 1);

beforeEach(async () => {
  await _resetStorageForTests();
  globalThis.indexedDB = new IDBFactory();
});

describe("deriveStealthKeys", () => {
  it("is deterministic and the same from the root or from WalletKeys", () => {
    const a = deriveStealthKeys(root);
    const b = deriveStealthKeys(deriveKeys(root));
    expect(a).toEqual(b);
    expect(a.metaAddressURI).toMatch(/^st:eth:0x[0-9a-f]{132}$/);
    expect(a.spendingPrivateKey).not.toBe(a.viewingPrivateKey);
  });

  it("differs per root", () => {
    const other = new Uint8Array(32).fill(5);
    expect(deriveStealthKeys(other).spendingPublicKey).not.toBe(deriveStealthKeys(root).spendingPublicKey);
  });
});

describe("one-time destinations on the device", () => {
  it("generates fresh owned destinations and persists each before returning", async () => {
    const keys = deriveStealthKeys(root);
    const d1 = await newOneTimeDestination(keys);
    const d2 = await newOneTimeDestination(keys);
    expect(d1.address).not.toBe(d2.address);
    expect(ownsDestination(keys, d1)).toBe(true);
    expect(await kvGet(`onetime:${d1.address.toLowerCase()}`)).toEqual(d1);
    const list = await listOneTimeDestinations();
    expect(list.map((d) => d.address).sort()).toEqual([d1.address, d2.address].sort());
    for (const d of list) expect(isAddressEqual(privateKeyToAccount(recoverSpendKey(keys, d)).address, d.address)).toBe(true);
  });

  it("reports token + ETH balance per destination", async () => {
    const keys = deriveStealthKeys(root);
    const d1 = await newOneTimeDestination(keys);
    const d2 = await newOneTimeDestination(keys);
    const fc = fakeChain({ chainId: 11155111, token: USDC });
    fc.setToken(d1.address, 2_000_000n);
    fc.setEth(d1.address, 7n);
    const pc = createPublicClient({ chain: chainOf(cfg), transport: fc.transport });
    const bals = await oneTimeBalances(pc, USDC);
    const by = new Map(bals.map((b) => [b.address, b]));
    expect(by.get(d1.address)).toMatchObject({ balance: 2_000_000n, eth: 7n });
    expect(by.get(d2.address)).toMatchObject({ balance: 0n, eth: 0n });
  });
});
