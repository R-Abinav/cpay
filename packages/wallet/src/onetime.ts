// Private receiving (stealth) and one-time pay, on the device. docs/ARCHITECTURE.md "(3) Receiving" and
// "Implementation notes -> Stealth".
//
// - Stealth keys come from the passkey root (HKDF labels cpay/v1/stealth-spend, cpay/v1/stealth-view).
// - The recipient generates every destination itself and stores {address, ephemeralPublicKey, viewTag}
//   in IndexedDB on this phone, so it can recover the one-time key and sweep later. No on-chain announcement.
// - Nothing here logs. Addresses and amounts never leave the phone except as the signed transactions.
import {
  createOneTimeDestination,
  keysFromSeed,
  payToDestination,
  recoverSpendKey,
  sweep,
  DEFAULT_GAS_DROP_WEI,
  type OneTimeDestination,
  type PayResult,
  type StealthKeys,
} from "@cpay/stealth";
import {
  createPublicClient,
  createWalletClient,
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
import { privateKeyToAccount } from "viem/accounts";
import { shieldFromOneTime, type RailgunWalletKeys } from "@cpay/railgun";
import { chainFromEnv, chainOf, type ChainConfig } from "./chain.js";
import { deriveKeys, type WalletKeys } from "./keys.js";
import { kvGet, kvList, kvSet } from "./storage.js";

export { DEFAULT_GAS_DROP_WEI, type OneTimeDestination, type StealthKeys };

/** IndexedDB key prefix (db "cpay-wallet", store "kv"): one record per destination handed out. */
export const ONETIME_PREFIX = "onetime:";

export interface StoredDestination extends OneTimeDestination {
  /** ms since epoch, when this phone generated it */
  createdAt: number;
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

export interface ShieldOneTimeToRailgunParams extends ChainOpts {
  stealthKeys: StealthKeys;
  railgunKeys: RailgunWalletKeys;
  /** a destination stored on this phone */
  destination: Address;
  /** defaults to cfg.usdc */
  token?: Address;
}

/**
 * Move a one-time address's token balance into the recipient's private Railgun 0zk wallet.
 * This is the default privacy-preserving exit path: no links are made to the user's main wallet.
 */
export async function shieldOneTimeToRailgun(p: ShieldOneTimeToRailgunParams): Promise<{ hash: Hex; amount: bigint }> {
  const rec = await storedDestination(p.destination);
  const { cfg, chain, transport } = resolveChain(p);
  await assertChain(cfg, transport, chain);
  const stealthPrivateKey = recoverSpendKey(p.stealthKeys, rec);
  const oneTimeAccount = privateKeyToAccount(stealthPrivateKey);
  const pc = createPublicClient({ chain, transport });
  const wc = createWalletClient({ account: oneTimeAccount, chain, transport });
  const token = p.token ?? cfg.usdc;
  const balance = (await pc.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [oneTimeAccount.address],
  })) as bigint;
  if (balance <= 0n) throw new Error("wallet: one-time address has no token balance to shield");

  const railgunAddress: Address = (cfg.railgunAddress ?? "0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea") as Address;
  const res = await shieldFromOneTime(wc, pc, token, balance, p.railgunKeys, oneTimeAccount, railgunAddress);
  return { hash: res.txHash, amount: balance };
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
