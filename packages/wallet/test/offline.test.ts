// Offline CPay QR (cpay:2): the payer derives the one-time address from the meta-address, announces it on the
// ERC5564Announcer, pays; the recipient scans announcements with its viewing key and stores what it owns.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { isAddressEqual, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA_ANNOUNCER_START_BLOCK, ERC5564_ANNOUNCER, ownsDestination, recoverSpendKey } from "@cpay/stealth";
import {
  DEFAULT_GAS_DROP_WEI,
  deriveKeys,
  deriveOfflineDestination,
  deriveStealthKeys,
  listOneTimeDestinations,
  offlineQrText,
  offlineReceiveState,
  parseQr,
  payOffline,
  scanOfflinePayments,
  setOfflineReceive,
  type ChainConfig,
} from "../src/index.js";
import { _resetStorageForTests } from "../src/storage.js";
import { fakeChain } from "./fakechain.js";

const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const cfg: ChainConfig = { chainId: 84532, rpcUrl: "http://fake.invalid", usdc: USDC, explorerUrl: "https://x.invalid" };
const recipientRoot = new Uint8Array(32).map((_, i) => i + 1);
const payerRoot = new Uint8Array(32).fill(7);

beforeEach(async () => {
  await _resetStorageForTests();
  globalThis.indexedDB = new IDBFactory();
});

describe("offline CPay QR format", () => {
  const keys = deriveStealthKeys(recipientRoot);

  it("round-trips the meta-address, upper-case alphanumeric, 139 chars", () => {
    const t = offlineQrText(keys.metaAddressURI);
    expect(t).toMatch(/^CPAY:2:[0-9A-F]{132}$/);
    expect(t.length).toBe(139);
    expect(parseQr(t, cfg)).toEqual({ kind: "offline", metaAddress: keys.metaAddressURI });
    expect(parseQr(t.toLowerCase(), cfg)).toEqual({ kind: "offline", metaAddress: keys.metaAddressURI });
  });

  it.each([
    ["not points", `cpay:2:${"00".repeat(66)}`],
    ["too short", `cpay:2:${keys.metaAddressURI.slice(9, 139)}`],
    ["too long", `cpay:2:${keys.metaAddressURI.slice(9)}00`],
    ["with 0x", `cpay:2:0x${keys.metaAddressURI.slice(9)}`],
    ["st: URI", keys.metaAddressURI],
  ])("rejects %s", (_, t) => {
    expect(parseQr(t, cfg)).toEqual({ kind: "unsupported", reason: "not_wallet" });
  });

  it("offlineQrText refuses a bad meta-address", () => {
    expect(() => offlineQrText("st:eth:0x" + "00".repeat(66))).toThrow();
    expect(() => offlineQrText("hello")).toThrow();
  });
});

describe("offline pay + scan", { timeout: 60_000 }, () => {
  const recipient = deriveStealthKeys(recipientRoot);
  const account = privateKeyToAccount(deriveKeys(payerRoot).agentPrivateKey);

  function chain() {
    const fc = fakeChain({ chainId: 84532, token: USDC });
    fc.mine(BASE_SEPOLIA_ANNOUNCER_START_BLOCK); // a realistic head
    fc.setToken(account.address, 5_000_000n);
    fc.setEth(account.address, 10n ** 16n);
    return fc;
  }

  it("payer: fresh address per payment, announced FIRST with only the view tag, then USDC + gas drop", async () => {
    const fc = chain();
    const d1 = deriveOfflineDestination(recipient.metaAddressURI);
    const d2 = deriveOfflineDestination(recipient.metaAddressURI);
    expect(d1.address).not.toBe(d2.address);
    expect(ownsDestination(recipient, d1)).toBe(true);

    const r = await payOffline({ account, destination: d1, amount: 2_000_000n, cfg, transport: fc.transport });
    expect(fc.sent).toHaveLength(3);
    const [a, t, g] = fc.sent;
    expect(a).toMatchObject({ from: account.address, to: ERC5564_ANNOUNCER, hash: r.announceHash });
    expect(a!.announce).toEqual({ schemeId: 1n, stealthAddress: d1.address, ephemeralPubKey: d1.ephemeralPublicKey, metadata: d1.viewTag });
    expect(a!.announce!.metadata).toMatch(/^0x[0-9a-f]{2}$/); // 1 byte: no token, no amount
    expect(t).toMatchObject({ transfer: { token: USDC, to: d1.address, amount: 2_000_000n }, hash: r.transferHash });
    expect(g).toMatchObject({ to: d1.address, value: DEFAULT_GAS_DROP_WEI });
  });

  it("recipient: finds exactly its payments by scanning with the viewing key, stores them, never twice", async () => {
    const fc = chain();
    expect(await scanOfflinePayments({ stealthKeys: recipient, cfg, transport: fc.transport })).toEqual({ found: [], scannedTo: null });
    const st = await setOfflineReceive(true, { cfg, transport: fc.transport });
    expect(st.enabled).toBe(true);
    expect(BigInt(st.nextBlock!)).toBeGreaterThanOrEqual(BASE_SEPOLIA_ANNOUNCER_START_BLOCK);

    const mine = deriveOfflineDestination(recipient.metaAddressURI);
    await payOffline({ account, destination: mine, amount: 1_000_000n, cfg, transport: fc.transport });
    const other = deriveStealthKeys(new Uint8Array(32).fill(3));
    await payOffline({ account, destination: deriveOfflineDestination(other.metaAddressURI), amount: 1n, cfg, transport: fc.transport });

    const res = await scanOfflinePayments({ stealthKeys: recipient, cfg, transport: fc.transport, chunk: 2n });
    expect(res.found.map((d) => d.address)).toEqual([mine.address]);
    expect(res.found[0]).toMatchObject({ via: "announcement", ephemeralPublicKey: mine.ephemeralPublicKey, viewTag: mine.viewTag });
    // the stored record recovers the spend key on this phone
    const stored = (await listOneTimeDestinations()).find((d) => d.address === mine.address)!;
    expect(isAddressEqual(privateKeyToAccount(recoverSpendKey(recipient, stored)).address, mine.address)).toBe(true);
    // chunked getLogs
    expect(fc.getLogsCalls.every((c) => c.toBlock - c.fromBlock <= 1n)).toBe(true);
    // cursor advanced: a second scan finds nothing new and doesn't re-read old blocks
    const before = fc.getLogsCalls.length;
    expect((await scanOfflinePayments({ stealthKeys: recipient, cfg, transport: fc.transport })).found).toEqual([]);
    expect(fc.getLogsCalls.length).toBe(before);
    expect(BigInt((await offlineReceiveState()).nextBlock!)).toBe(res.scannedTo! + 1n);
  });

  it("announcements from before the user enabled offline receive are not scanned", async () => {
    const fc = chain();
    const early = deriveOfflineDestination(recipient.metaAddressURI);
    await payOffline({ account, destination: early, amount: 1n, cfg, transport: fc.transport });
    await setOfflineReceive(true, { cfg, transport: fc.transport });
    fc.mine(1n);
    expect((await scanOfflinePayments({ stealthKeys: recipient, cfg, transport: fc.transport })).found).toEqual([]);
  });

  it("refuses a wrong-chain RPC before signing anything", async () => {
    const fc = fakeChain({ chainId: 1, token: USDC });
    await expect(
      payOffline({ account, destination: deriveOfflineDestination(recipient.metaAddressURI), amount: 1n, cfg, transport: fc.transport }),
    ).rejects.toThrow(/chain/);
    expect(fc.sent).toHaveLength(0);
  });
});
