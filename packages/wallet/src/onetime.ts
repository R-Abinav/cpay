// Private receiving (stealth) and one-time pay, on the device. docs/ARCHITECTURE.md "(3) Receiving" and
// "Implementation notes -> Stealth".
//
// - Stealth keys come from the passkey root (HKDF labels cpay/v1/stealth-spend, cpay/v1/stealth-view).
// - Online (CPay QR / face): the recipient generates every destination itself and stores {address,
//   ephemeralPublicKey, viewTag} in IndexedDB on this phone, so it can recover the one-time key and sweep later.
//   No on-chain announcement.
// - Offline (opt-in `cpay:2:` QR): the PAYER derives the destination from the meta-address and announces it on the
//   ERC5564Announcer; the recipient later scans announcements with its viewing key ON THE PHONE and stores the
//   ones it owns in the same list.
// - Nothing here logs. Addresses and amounts never leave the phone except as the signed transactions.
import {
  BASE_SEPOLIA_ANNOUNCER_START_BLOCK,
  announceDestination,
  createOneTimeDestination,
  destinationForMetaAddress,
  keysFromSeed,
  ownsDestination,
  payToDestination,
  recoverSpendKey,
  scanAnnouncements,
  sweep,
  DEFAULT_GAS_DROP_WEI,
  type OneTimeDestination,
  type PayResult,
  type StealthKeys,
} from "@cpay/stealth";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { chainFromEnv, chainOf, type ChainConfig } from "./chain.js";
import { deriveKeys, type WalletKeys } from "./keys.js";
import { kvGet, kvList, kvSet } from "./storage.js";

export { DEFAULT_GAS_DROP_WEI, type OneTimeDestination, type StealthKeys };

/** IndexedDB key prefix (db "cpay-wallet", store "kv"): one record per destination handed out. */
export const ONETIME_PREFIX = "onetime:";

export interface StoredDestination extends OneTimeDestination {
  /** ms since epoch, when this phone generated (or, for announcements, found) it */
  createdAt: number;
  /** "announcement": a payer derived it from our offline QR and announced it on chain. Absent = generated here. */
  via?: "announcement";
}

export interface DestinationBalance extends StoredDestination {
  /** token base units */
  balance: bigint;
  /** wei (what is left of the gas drop) */
  eth: bigint;
}

/**
 * Stealth spending/viewing keys, from the 32-byte passkey root or from already-derived WalletKeys
 * (WalletHandle.keys). Deterministic; stays in memory on this phone.
 */
export function deriveStealthKeys(src: Uint8Array | WalletKeys): StealthKeys {
  const k = src instanceof Uint8Array ? deriveKeys(src) : src;
  return keysFromSeed(k.stealthSpend, k.stealthView);
}

/** A fresh one-time address to our own meta-address, persisted on this phone before it is returned. */
export async function newOneTimeDestination(keys: StealthKeys): Promise<StoredDestination> {
  const d = createOneTimeDestination(keys);
  const rec: StoredDestination = { address: d.address, ephemeralPublicKey: d.ephemeralPublicKey, viewTag: d.viewTag, createdAt: Date.now() };
  await kvSet(ONETIME_PREFIX + rec.address.toLowerCase(), rec);
  return rec;
}

/** Every destination this phone handed out, oldest first. */
export async function listOneTimeDestinations(): Promise<StoredDestination[]> {
  const all = await kvList<StoredDestination>(ONETIME_PREFIX);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

async function storedDestination(address: Address): Promise<StoredDestination> {
  if (!isAddress(address)) throw new Error("wallet: bad one-time address");
  const rec = await kvGet<StoredDestination>(ONETIME_PREFIX + address.toLowerCase());
  if (!rec) throw new Error("wallet: unknown one-time address");
  return rec;
}

/**
 * Token + ETH balance of every stored destination. Note: this asks one RPC about all of them at once, so that
 * RPC can link them. Call it only when the user opens the private-funds view.
 */
export async function oneTimeBalances(publicClient: PublicClient, token: Address): Promise<DestinationBalance[]> {
  const list = await listOneTimeDestinations();
  return Promise.all(
    list.map(async (d) => {
      const [balance, eth] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [d.address] }),
        publicClient.getBalance({ address: d.address }),
      ]);
      return { ...d, balance, eth };
    }),
  );
}

interface ChainOpts {
  /** defaults to chainFromEnv() (NEXT_PUBLIC_CHAIN_ID / NEXT_PUBLIC_RPC_URL / NEXT_PUBLIC_USDC_ADDRESS) */
  cfg?: ChainConfig;
  /** defaults to http(cfg.rpcUrl); tests inject a custom transport */
  transport?: Transport;
}

function resolveChain(o: ChainOpts) {
  const cfg = o.cfg ?? chainFromEnv();
  const transport = o.transport ?? http(cfg.rpcUrl, { timeout: 15_000 });
  return { cfg, chain: chainOf(cfg), transport };
}

async function assertChain(cfg: ChainConfig, transport: Transport, chain: ReturnType<typeof chainOf>): Promise<void> {
  const id = await createPublicClient({ chain, transport }).getChainId();
  if (id !== cfg.chainId) throw new Error(`wallet: RPC is on chain ${id}, expected ${cfg.chainId}`);
}

export interface SweepOneTimeParams extends ChainOpts {
  stealthKeys: StealthKeys;
  /** a destination stored on this phone */
  destination: Address;
  /** usually the agent wallet. This links the one-time address to `to` on-chain: the UI must say so. */
  to: Address;
  /** defaults to cfg.usdc */
  token?: Address;
}

/** Move a one-time address's full token balance to `to`, paying gas from its gas drop. Signed on the phone. */
export async function sweepOneTime(p: SweepOneTimeParams): Promise<{ hash: Hex; amount: bigint }> {
  if (!isAddress(p.to)) throw new Error("wallet: bad sweep target");
  const rec = await storedDestination(p.destination);
  const { cfg, chain, transport } = resolveChain(p);
  await assertChain(cfg, transport, chain);
  const stealthPrivateKey = recoverSpendKey(p.stealthKeys, rec);
  return sweep({ stealthPrivateKey, to: getAddress(p.to), token: p.token ?? cfg.usdc, chain, transport });
}

export interface PayOneTimeParams extends ChainOpts {
  /** the agent wallet (WalletHandle.account) */
  account: Account;
  /** the one-time address from a VERIFIED claim (verifyClaim2), never from anywhere else */
  destination: Address;
  /** token base units */
  amount: bigint;
  /** defaults to cfg.usdc */
  token?: Address;
  /** defaults to DEFAULT_GAS_DROP_WEI (0.0003 ETH) */
  gasDropWei?: bigint;
}

// ---------------------------------------------------------------- offline receiving (opt-in)

/** Payer: a fresh one-time address for the meta-address in a scanned offline QR (parseQr kind "offline"). */
export function deriveOfflineDestination(metaAddress: string): OneTimeDestination {
  return destinationForMetaAddress(metaAddress);
}

export interface PayOfflineParams extends ChainOpts {
  account: Account;
  /** from deriveOfflineDestination, on this phone; never from anywhere else */
  destination: OneTimeDestination;
  /** token base units */
  amount: bigint;
  token?: Address;
  gasDropWei?: bigint;
}

/**
 * Payer, offline QR: announce the destination on the ERC5564Announcer FIRST (so the recipient can always find what
 * follows), then USDC + gas drop, all signed by the agent wallet here. Three transactions, all from the agent wallet:
 * chain observers see that it paid a stealth address (the transfer shows that anyway).
 */
export async function payOffline(p: PayOfflineParams): Promise<PayResult & { announceHash: Hex }> {
  if (!isAddress(p.destination.address)) throw new Error("wallet: bad destination");
  if (typeof p.amount !== "bigint" || p.amount <= 0n) throw new Error("wallet: amount must be positive base units");
  const { cfg, chain, transport } = resolveChain(p);
  await assertChain(cfg, transport, chain);
  const announceHash = await announceDestination({ account: p.account, destination: p.destination, chain, transport });
  const r = await payToDestination({
    account: p.account,
    destination: getAddress(p.destination.address),
    amount: p.amount,
    token: p.token ?? cfg.usdc,
    gasDropWei: p.gasDropWei ?? DEFAULT_GAS_DROP_WEI,
    chain,
    transport,
  });
  return { ...r, announceHash };
}

/** IndexedDB key for the offline-receive switch + scan cursor. */
export const OFFLINE_RECEIVE_KEY = "offline-receive";

export interface OfflineReceiveState {
  enabled: boolean;
  /** next block to scan (decimal string), or null before the first enable */
  nextBlock: string | null;
}

export async function offlineReceiveState(): Promise<OfflineReceiveState> {
  return (await kvGet<OfflineReceiveState>(OFFLINE_RECEIVE_KEY)) ?? { enabled: false, nextBlock: null };
}

/**
 * Turn "receive while offline" on or off. The first enable sets the scan cursor to the current block: nothing
 * before it can be for our offline QR, which didn't exist yet (and scanning from deployment would be slow).
 */
export async function setOfflineReceive(enabled: boolean, opts: ChainOpts = {}): Promise<OfflineReceiveState> {
  const prev = await offlineReceiveState();
  let nextBlock = prev.nextBlock;
  if (enabled && nextBlock === null) {
    const { cfg, chain, transport } = resolveChain(opts);
    const head = await createPublicClient({ chain, transport }).getBlockNumber();
    const floor = cfg.chainId === 84532 ? BASE_SEPOLIA_ANNOUNCER_START_BLOCK : 0n;
    nextBlock = (head > floor ? head : floor).toString();
  }
  const next = { enabled, nextBlock };
  await kvSet(OFFLINE_RECEIVE_KEY, next);
  return next;
}

export interface ScanOfflineParams extends ChainOpts {
  stealthKeys: StealthKeys;
  /** blocks per getLogs call */
  chunk?: bigint;
}

/**
 * Recipient: scan announcements since the cursor with the viewing key (on this phone), store every one-time
 * address we own (then it shows up in balances / sweep like any other), advance the cursor. Returns the new ones.
 */
export async function scanOfflinePayments(p: ScanOfflineParams): Promise<{ found: StoredDestination[]; scannedTo: bigint | null }> {
  const st = await offlineReceiveState();
  if (st.nextBlock === null) return { found: [], scannedTo: null };
  const { cfg, chain, transport } = resolveChain(p);
  await assertChain(cfg, transport, chain);
  const head = await createPublicClient({ chain, transport }).getBlockNumber();
  const from = BigInt(st.nextBlock);
  if (from > head) return { found: [], scannedTo: head };
  const owned = await scanAnnouncements({ keys: p.stealthKeys, fromBlock: from, toBlock: head, chain, transport, chunk: p.chunk });
  const found: StoredDestination[] = [];
  for (const d of owned) {
    const key = ONETIME_PREFIX + d.address.toLowerCase();
    if (await kvGet(key)) continue;
    if (!ownsDestination(p.stealthKeys, d)) continue; // belt and braces: never store an address we can't spend
    const rec: StoredDestination = { ...d, createdAt: Date.now(), via: "announcement" };
    await kvSet(key, rec);
    found.push(rec);
  }
  await kvSet(OFFLINE_RECEIVE_KEY, { ...st, nextBlock: (head + 1n).toString() });
  return { found, scannedTo: head };
}

/**
 * Token transfer + ETH gas drop to a one-time address, both signed by the agent wallet on this phone.
 * Policy, Agent Pass and the spoken confirm must already have passed. Throws on a wrong chain or a revert.
 */
export async function payOneTime(p: PayOneTimeParams): Promise<PayResult> {
  if (!isAddress(p.destination)) throw new Error("wallet: bad destination");
  if (typeof p.amount !== "bigint" || p.amount <= 0n) throw new Error("wallet: amount must be positive base units");
  const { cfg, chain, transport } = resolveChain(p);
  await assertChain(cfg, transport, chain);
  return payToDestination({
    account: p.account,
    destination: getAddress(p.destination),
    amount: p.amount,
    token: p.token ?? cfg.usdc,
    gasDropWei: p.gasDropWei ?? DEFAULT_GAS_DROP_WEI,
    chain,
    transport,
  });
}
