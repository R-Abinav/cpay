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
  sendFromOneTime,
  sweep,
  sweepEth,
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

export interface SweepOneTimeResult {
  hash: Hex;
  amount: bigint;
  /** the leftover gas-drop ETH sent to the same target after the token sweep; null if only dust was left */
  eth: { hash: Hex; amount: bigint } | null;
  /** set when the ETH leg failed after the token sweep succeeded */
  ethError?: string;
}

/**
 * Move a one-time address's full token balance to `to`, paying gas from its gas drop, then (unless
 * `sweepEth: false`) what is left of the gas drop minus fees. Both are signed on the phone by the one-time key.
 * Sending the ETH to the same target adds no new link: the token sweep already ties the two together.
 */
export async function sweepOneTime(p: SweepOneTimeParams & { sweepEth?: boolean }): Promise<SweepOneTimeResult> {
  if (!isAddress(p.to)) throw new Error("wallet: bad sweep target");
  const rec = await storedDestination(p.destination);
  const { cfg, chain, transport } = resolveChain(p);
  await assertChain(cfg, transport, chain);
  const stealthPrivateKey = recoverSpendKey(p.stealthKeys, rec);
  const to = getAddress(p.to);
  const t = await sweep({ stealthPrivateKey, to, token: p.token ?? cfg.usdc, chain, transport });
  if (p.sweepEth === false) return { ...t, eth: null };
  // The token sweep already went through: an ETH-leg failure must not hide that, so it is reported, not thrown.
  try {
    return { ...t, eth: await sweepEth({ stealthPrivateKey, to, chain, transport }) };
  } catch (e) {
    return { ...t, eth: null, ethError: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- send from the private balance

/** Gas budget for one ERC-20 transfer from a one-time address (a USDC transfer uses ~40-65k). */
const TOKEN_TRANSFER_GAS = 100_000n;

export interface PrivateSendLeg {
  /** a one-time address stored on this phone */
  from: Address;
  /** token base units it sends */
  amount: bigint;
}

/**
 * Pure: which one-time addresses pay `amount`. Only sources with a token balance and at least `minGasWei`
 * of ETH qualify. Uses the fewest addresses possible (every extra address is linked to the others by
 * paying the same recipient together): the largest balances first, and for the last leg the smallest balance
 * that still covers the rest, so big balances stay whole. Every leg but the last sends its full balance.
 * Returns null if the qualifying sources can't cover `amount`.
 */
export function planPrivateSend(
  sources: readonly { address: Address; balance: bigint; eth: bigint }[],
  amount: bigint,
  minGasWei: bigint,
): PrivateSendLeg[] | null {
  if (amount <= 0n) return null;
  const ok = sources.filter((s) => s.balance > 0n && s.eth >= minGasWei).sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
  // fewest legs k: the smallest k whose k largest balances cover amount
  let k = 0;
  let sum = 0n;
  while (k < ok.length && sum < amount) sum += ok[k++]!.balance;
  if (sum < amount) return null;
  const head = ok.slice(0, k - 1);
  const rest = amount - head.reduce((s, x) => s + x.balance, 0n);
  // the smallest remaining source that covers the rest (ok[k-1] always does)
  const tail = ok.slice(k - 1);
  let last = tail[0]!;
  for (const s of tail) if (s.balance >= rest && s.balance < last.balance) last = s;
  return [...head.map((s) => ({ from: s.address, amount: s.balance })), { from: last.address, amount: rest }];
}

export interface SendFromPrivateParams extends ChainOpts {
  stealthKeys: StealthKeys;
  /** the recipient: pasted or scanned by the user on this phone */
  to: Address;
  /** token base units */
  amount: bigint;
  /** defaults to cfg.usdc */
  token?: Address;
}

export interface PrivateSendResult {
  legs: (PrivateSendLeg & { hash: Hex })[];
}

/** Thrown when a later leg fails after earlier legs were already sent. `done` lists what went through. */
export class PrivateSendError extends Error {
  constructor(
    message: string,
    readonly done: (PrivateSendLeg & { hash: Hex })[],
  ) {
    super(message);
    this.name = "PrivateSendError";
  }
}

/**
 * Pay `to` straight from the one-time addresses on this phone: each one signs its own token transfer with its
 * recovered key and pays gas from its gas drop. The main (agent) wallet signs nothing and appears nowhere.
 * If more than one address is needed they are linked to each other (same recipient, same moment); the plan
 * uses as few as possible. Reads every destination's balance first (one RPC, which can link them: disclosed
 * in the UI). Throws before signing anything if the private balance can't cover `amount`.
 */
export async function sendFromPrivate(p: SendFromPrivateParams): Promise<PrivateSendResult> {
  if (!isAddress(p.to)) throw new Error("wallet: bad recipient address");
  if (typeof p.amount !== "bigint" || p.amount <= 0n) throw new Error("wallet: amount must be positive base units");
  const { cfg, chain, transport } = resolveChain(p);
  await assertChain(cfg, transport, chain);
  const token = p.token ?? cfg.usdc;
  const to = getAddress(p.to);
  const pub = createPublicClient({ chain, transport });

  const stored = await listOneTimeDestinations();
  if (stored.some((d) => d.address.toLowerCase() === to.toLowerCase())) throw new Error("wallet: that is one of your own one-time addresses");
  const [rows, fees] = await Promise.all([oneTimeBalances(pub as PublicClient, token), pub.estimateFeesPerGas()]);
  // 2x headroom covers fee moves between now and inclusion and Base's small L1 data fee
  const minGasWei = 2n * TOKEN_TRANSFER_GAS * fees.maxFeePerGas;
  const plan = planPrivateSend(rows, p.amount, minGasWei);
  if (!plan) {
    const total = rows.reduce((s, r) => s + r.balance, 0n);
    throw new Error(total >= p.amount ? "wallet: not enough gas left on the one-time addresses that hold the funds" : "wallet: private balance too low");
  }

  const byAddr = new Map(stored.map((d) => [d.address.toLowerCase(), d]));
  const done: (PrivateSendLeg & { hash: Hex })[] = [];
  for (const leg of plan) {
    try {
      const stealthPrivateKey = recoverSpendKey(p.stealthKeys, byAddr.get(leg.from.toLowerCase())!);
      const r = await sendFromOneTime({ stealthPrivateKey, to, amount: leg.amount, token, chain, transport });
      done.push({ ...leg, hash: r.hash });
    } catch (e) {
      if (done.length === 0) throw e;
      throw new PrivateSendError(`wallet: sent ${done.length} of ${plan.length} parts, then: ${e instanceof Error ? e.message : String(e)}`, done);
    }
  }
  return { legs: done };
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
