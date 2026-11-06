// One-time destinations (stealth): derivation, persistence, balances, sweep and pay, against an in-memory chain.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, isAddressEqual, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ownsDestination, recoverSpendKey } from "@cpay/stealth";
import {
  DEFAULT_GAS_DROP_WEI,
  chainOf,
  deriveKeys,
  deriveStealthKeys,
  listOneTimeDestinations,
  newOneTimeDestination,
  oneTimeBalances,
  payOneTime,
  sweepOneTime,
  type ChainConfig,
} from "../src/index.js";
import { _resetStorageForTests, kvGet } from "../src/storage.js";
import { fakeChain } from "./fakechain.js";

const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const cfg: ChainConfig = { chainId: 84532, rpcUrl: "http://fake.invalid", usdc: USDC, explorerUrl: "https://x.invalid" };
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
    const fc = fakeChain({ chainId: 84532, token: USDC });
    fc.setToken(d1.address, 2_000_000n);
    fc.setEth(d1.address, 7n);
    const pc = createPublicClient({ chain: chainOf(cfg), transport: fc.transport });
    const bals = await oneTimeBalances(pc, USDC);
    const by = new Map(bals.map((b) => [b.address, b]));
    expect(by.get(d1.address)).toMatchObject({ balance: 2_000_000n, eth: 7n });
    expect(by.get(d2.address)).toMatchObject({ balance: 0n, eth: 0n });
  });
});

describe("sweepOneTime", () => {
  it("moves the whole token balance to the target, signed by the recovered one-time key", async () => {
    const keys = deriveStealthKeys(root);
    const d = await newOneTimeDestination(keys);
    const fc = fakeChain({ chainId: 84532, token: USDC });
    fc.setToken(d.address, 1_500_000n);
    fc.setEth(d.address, DEFAULT_GAS_DROP_WEI);
    const agent = privateKeyToAccount(deriveKeys(root).agentPrivateKey).address;
    const out = await sweepOneTime({ stealthKeys: keys, destination: d.address, to: agent, cfg, transport: fc.transport });
    expect(out.amount).toBe(1_500_000n);
    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]!.from).toBe(d.address);
    expect(fc.sent[0]!.transfer).toEqual({ token: USDC, to: agent, amount: 1_500_000n });
    expect(fc.tokenOf(agent)).toBe(1_500_000n);
  });

  it("refuses an address this phone never handed out", async () => {
    const keys = deriveStealthKeys(root);
    const fc = fakeChain({ chainId: 84532, token: USDC });
    await expect(
      sweepOneTime({ stealthKeys: keys, destination: privateKeyToAccount(generatePrivateKey()).address, to: USDC, cfg, transport: fc.transport }),
    ).rejects.toThrow(/unknown one-time/);
  });

  it("refuses when another wallet's keys are used", async () => {
    const d = await newOneTimeDestination(deriveStealthKeys(root));
    const fc = fakeChain({ chainId: 84532, token: USDC });
    fc.setToken(d.address, 1n);
    await expect(
      sweepOneTime({ stealthKeys: deriveStealthKeys(new Uint8Array(32).fill(9)), destination: d.address, to: USDC, cfg, transport: fc.transport }),
    ).rejects.toThrow(/does not control/);
    expect(fc.sent).toHaveLength(0);
  });
});

describe("payOneTime", () => {
  const account = privateKeyToAccount(deriveKeys(root).agentPrivateKey);
  const dest = privateKeyToAccount(generatePrivateKey()).address;

  function funded() {
    const fc = fakeChain({ chainId: 84532, token: USDC });
    fc.setToken(account.address, 5_000_000n);
    fc.setEth(account.address, 10n ** 16n);
    return fc;
  }

  it("signs a USDC transfer + the default gas drop to the destination on the configured chain", async () => {
    const fc = funded();
    const r = await payOneTime({ account, destination: dest, amount: 2_000_000n, cfg, transport: fc.transport });
    expect(r.gasDropHash).not.toBeNull();
    expect(fc.sent).toHaveLength(2);
    const [t, g] = fc.sent;
    expect(t).toMatchObject({ from: account.address, to: USDC, chainId: 84532, transfer: { token: USDC, to: dest, amount: 2_000_000n } });
    expect(t!.hash).toBe(r.transferHash);
    expect(g).toMatchObject({ from: account.address, to: dest, value: DEFAULT_GAS_DROP_WEI, chainId: 84532 });
    expect(fc.tokenOf(dest)).toBe(2_000_000n);
  });

  it("honours a custom gas drop and skips it at zero", async () => {
    const fc = funded();
    const r = await payOneTime({ account, destination: dest, amount: 1n, gasDropWei: 0n, cfg, transport: fc.transport });
    expect(r.gasDropHash).toBeNull();
    expect(fc.sent).toHaveLength(1);
  });

  it("refuses a wrong-chain RPC before signing anything", async () => {
    const fc = fakeChain({ chainId: 11155111, token: USDC });
    await expect(payOneTime({ account, destination: dest, amount: 1n, cfg, transport: fc.transport })).rejects.toThrow(/expected 84532/);
    expect(fc.sent).toHaveLength(0);
  });

  it("refuses zero, negative or non-bigint amounts and bad destinations", async () => {
    const fc = funded();
    await expect(payOneTime({ account, destination: dest, amount: 0n, cfg, transport: fc.transport })).rejects.toThrow(/positive/);
    await expect(payOneTime({ account, destination: dest, amount: 2 as unknown as bigint, cfg, transport: fc.transport })).rejects.toThrow();
    await expect(payOneTime({ account, destination: "0x1234" as Address, amount: 1n, cfg, transport: fc.transport })).rejects.toThrow(/destination/);
    expect(fc.sent).toHaveLength(0);
  });

  it("refuses when the token balance is short", async () => {
    const fc = funded();
    await expect(payOneTime({ account, destination: dest, amount: 6_000_000n, cfg, transport: fc.transport })).rejects.toThrow(/insufficient token/);
    expect(fc.sent).toHaveLength(0);
  });

  it("throws on a reverted transfer and sends no gas drop", async () => {
    const fc = funded();
    fc.revertNextTx();
    await expect(payOneTime({ account, destination: dest, amount: 1n, cfg, transport: fc.transport })).rejects.toThrow(/reverted/);
    expect(fc.sent).toHaveLength(1);
  });
});
