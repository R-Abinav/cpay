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
  planPrivateSend,
  sendFromPrivate,
  PrivateSendError,
  sweepOneTime,
  type ChainConfig,
} from "../src/index.js";
import { _resetStorageForTests, kvGet } from "../src/storage.js";
import { L1_FEE, fakeChain } from "./fakechain.js";

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
    const out = await sweepOneTime({ stealthKeys: keys, destination: d.address, to: agent, cfg, transport: fc.transport, sweepEth: false });
    expect(out.amount).toBe(1_500_000n);
    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]!.from).toBe(d.address);
    expect(fc.sent[0]!.transfer).toEqual({ token: USDC, to: agent, amount: 1_500_000n });
    expect(fc.tokenOf(agent)).toBe(1_500_000n);
  });

  it("then sends the leftover gas-drop ETH minus the fee budget to the same target", async () => {
    const keys = deriveStealthKeys(root);
    const d = await newOneTimeDestination(keys);
    const fc = fakeChain({ chainId: 84532, token: USDC });
    fc.setToken(d.address, 1n);
    fc.setEth(d.address, DEFAULT_GAS_DROP_WEI);
    const agent = privateKeyToAccount(deriveKeys(root).agentPrivateKey).address;
    const out = await sweepOneTime({ stealthKeys: keys, destination: d.address, to: agent, cfg, transport: fc.transport });
    expect(fc.sent).toHaveLength(2);
    const e = fc.sent[1]!;
    expect(e).toMatchObject({ from: d.address, to: agent });
    expect(e.transfer).toBeUndefined();
    expect(out.eth).toEqual({ hash: e.hash, amount: e.value });
    // budget = 21000 * maxFeePerGas + 2 * L1 fee: a few thousand wei of dust at most on this fake chain
    const dust = DEFAULT_GAS_DROP_WEI - e.value;
    expect(dust).toBeGreaterThan(2n * L1_FEE);
    expect(dust).toBeLessThan(21_000n * 10n + 2n * L1_FEE);
  });

  it("skips the ETH leg when asked, or when only dust is left", async () => {
    const keys = deriveStealthKeys(root);
    const d = await newOneTimeDestination(keys);
    const fc = fakeChain({ chainId: 84532, token: USDC });
    fc.setToken(d.address, 5n);
    fc.setEth(d.address, DEFAULT_GAS_DROP_WEI);
    const r1 = await sweepOneTime({ stealthKeys: keys, destination: d.address, to: USDC, cfg, transport: fc.transport, sweepEth: false });
    expect(r1.eth).toBeNull();
    expect(fc.sent).toHaveLength(1);
    fc.setToken(d.address, 5n);
    fc.setEth(d.address, 100n);
    const r2 = await sweepOneTime({ stealthKeys: keys, destination: d.address, to: USDC, cfg, transport: fc.transport });
    expect(r2.eth).toBeNull();
    expect(fc.sent).toHaveLength(2);
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

describe("planPrivateSend", () => {
  const A = "0x000000000000000000000000000000000000000A" as Address;
  const B = "0x000000000000000000000000000000000000000b" as Address;
  const C = "0x000000000000000000000000000000000000000C" as Address;
  const D = "0x000000000000000000000000000000000000000d" as Address;
  const gas = 10n;
  const src = (address: Address, balance: bigint, eth = 100n) => ({ address, balance, eth });

  it("uses one address when one covers it: the smallest that does", () => {
    expect(planPrivateSend([src(A, 50n), src(B, 10n), src(C, 7n)], 8n, gas)).toEqual([{ from: B, amount: 8n }]);
    expect(planPrivateSend([src(A, 50n), src(B, 10n)], 10n, gas)).toEqual([{ from: B, amount: 10n }]);
  });

  it("uses the fewest addresses: largest first, smallest covering one last (partial)", () => {
    // 9 needs two: 5 (full) + the smallest that covers 4 -> 4
    expect(planPrivateSend([src(A, 5n), src(B, 4n), src(C, 3n), src(D, 1n)], 9n, gas)).toEqual([
      { from: A, amount: 5n },
      { from: B, amount: 4n },
    ]);
    // 7 needs two: 5 + smallest covering 2 -> C(3), leaving B(4) whole
    expect(planPrivateSend([src(A, 5n), src(B, 4n), src(C, 3n), src(D, 1n)], 7n, gas)).toEqual([
      { from: A, amount: 5n },
      { from: C, amount: 2n },
    ]);
  });

  it("skips sources without enough gas or without tokens", () => {
    expect(planPrivateSend([src(A, 50n, 9n), src(B, 10n), src(C, 0n)], 8n, gas)).toEqual([{ from: B, amount: 8n }]);
    expect(planPrivateSend([src(A, 50n, 9n), src(B, 5n)], 8n, gas)).toBeNull();
  });

  it("returns null when the total is short or the amount isn't positive", () => {
    expect(planPrivateSend([src(A, 5n), src(B, 4n)], 10n, gas)).toBeNull();
    expect(planPrivateSend([src(A, 5n)], 0n, gas)).toBeNull();
    expect(planPrivateSend([], 1n, gas)).toBeNull();
  });
});

describe("sendFromPrivate", () => {
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const agent = privateKeyToAccount(deriveKeys(root).agentPrivateKey).address;

  async function setup(balances: bigint[], eth = DEFAULT_GAS_DROP_WEI) {
    const keys = deriveStealthKeys(root);
    const fc = fakeChain({ chainId: 84532, token: USDC });
    const ds = [];
    for (const b of balances) {
      const d = await newOneTimeDestination(keys);
      fc.setToken(d.address, b);
      fc.setEth(d.address, eth);
      ds.push(d);
    }
    return { keys, fc, ds };
  }

  it("pays from a single one-time address, signed by its own key; the agent wallet signs nothing", async () => {
    const { keys, fc, ds } = await setup([3_000_000n, 1_000_000n]);
    const r = await sendFromPrivate({ stealthKeys: keys, to, amount: 800_000n, cfg, transport: fc.transport });
    expect(r.legs).toEqual([{ from: ds[1]!.address, amount: 800_000n, hash: fc.sent[0]!.hash }]);
    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]).toMatchObject({ from: ds[1]!.address, chainId: 84532, transfer: { token: USDC, to, amount: 800_000n } });
    expect(fc.sent.some((t) => t.from === agent)).toBe(false);
    expect(fc.tokenOf(to)).toBe(800_000n);
    expect(fc.tokenOf(ds[1]!.address)).toBe(200_000n);
  });

  it("splits across the fewest addresses, each signing its own transfer", async () => {
    const { keys, fc, ds } = await setup([3_000_000n, 1_000_000n, 2_000_000n]);
    const r = await sendFromPrivate({ stealthKeys: keys, to, amount: 4_500_000n, cfg, transport: fc.transport });
    expect(r.legs.map((l) => [l.from, l.amount])).toEqual([
      [ds[0]!.address, 3_000_000n],
      [ds[2]!.address, 1_500_000n],
    ]);
    expect(fc.sent.map((t) => t.from)).toEqual([ds[0]!.address, ds[2]!.address]);
    expect(fc.tokenOf(to)).toBe(4_500_000n);
  });

  it("refuses before signing when the private balance is too low or gas is missing", async () => {
    const a = await setup([1_000_000n]);
    await expect(sendFromPrivate({ stealthKeys: a.keys, to, amount: 2_000_000n, cfg, transport: a.fc.transport })).rejects.toThrow(/too low/);
    expect(a.fc.sent).toHaveLength(0);
    await _resetStorageForTests();
    globalThis.indexedDB = new IDBFactory();
    const b = await setup([5_000_000n], 0n);
    await expect(sendFromPrivate({ stealthKeys: b.keys, to, amount: 1n, cfg, transport: b.fc.transport })).rejects.toThrow(/gas/);
    expect(b.fc.sent).toHaveLength(0);
  });

  it("refuses bad input, a wrong chain and sending to its own one-time address", async () => {
    const { keys, fc, ds } = await setup([1_000_000n]);
    await expect(sendFromPrivate({ stealthKeys: keys, to: "0x12" as Address, amount: 1n, cfg, transport: fc.transport })).rejects.toThrow(/recipient/);
    await expect(sendFromPrivate({ stealthKeys: keys, to, amount: 0n, cfg, transport: fc.transport })).rejects.toThrow(/positive/);
    await expect(sendFromPrivate({ stealthKeys: keys, to: ds[0]!.address, amount: 1n, cfg, transport: fc.transport })).rejects.toThrow(/own one-time/);
    const wrong = fakeChain({ chainId: 1, token: USDC });
    await expect(sendFromPrivate({ stealthKeys: keys, to, amount: 1n, cfg, transport: wrong.transport })).rejects.toThrow(/expected 84532/);
    expect(fc.sent).toHaveLength(0);
  });

  it("reports the legs already sent when a later one reverts", async () => {
    const { keys, fc, ds } = await setup([3_000_000n, 2_000_000n]);
    const orig = fc.transport;
    let n = 0;
    const transport: typeof orig = (o) => {
      const t = orig(o);
      return {
        ...t,
        request: (async (args: { method: string }) => {
          if (args.method === "eth_sendRawTransaction" && ++n === 2) fc.revertNextTx();
          return t.request(args as never);
        }) as typeof t.request,
      };
    };
    const err = await sendFromPrivate({ stealthKeys: keys, to, amount: 4_000_000n, cfg, transport }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrivateSendError);
    expect((err as PrivateSendError).done).toEqual([{ from: ds[0]!.address, amount: 3_000_000n, hash: fc.sent[0]!.hash }]);
  });
});
