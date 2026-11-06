// Recipient-generated ERC-5564 (scheme 1, secp256k1) one-time addresses on top of the ScopeLift SDK,
// plus pay (USDC transfer + ETH gas drop) and sweep. No EC maths here; the SDK and viem do it.
// Offline receiving (opt-in): the payer derives the address from the recipient's meta-address and announces it
// on the canonical ERC5564Announcer; the recipient scans announcements with its viewing key.
//
// This package never reads env vars or keys itself. Callers pass a viem Account (the agent wallet
// for pay, the recovered one-time key for sweep) and a transport.
import {
  ERC5564AnnouncerAbi,
  ERC5564_CONTRACT_ADDRESS,
  ERC5564_StartBlocks,
  VALID_SCHEME_ID,
  checkStealthAddress,
  computeStealthKey,
  generateKeysFromSignature,
  generateStealthAddress,
  generateStealthMetaAddressFromKeys,
  parseKeysFromStealthMetaAddress,
} from "@scopelift/stealth-address-sdk";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  isAddressEqual,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { estimateL1Fee } from "viem/op-stack";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Circle testnet USDC on Ethereum Sepolia (11155111). Not the CPay default chain. */
export const SEPOLIA_USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
/** Circle testnet USDC on Base Sepolia (84532), the CPay payment chain. */
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** ~0.0003 ETH: enough for the one-time address to move its USDC later. */
export const DEFAULT_GAS_DROP_WEI = 300_000_000_000_000n;

/**
 * The wallet signs this exact message once; the signature deterministically derives the stealth keys.
 * It must never be signed anywhere else.
 */
export const KEY_DERIVATION_MESSAGE = [
  "CPay stealth keys v1",
  "",
  "Signing this message derives the private keys that receive and spend your CPay payments.",
  "Only sign it inside the CPay app. Any site that obtains this signature can see and spend",
  "every payment you receive through CPay.",
].join("\n");

export interface StealthKeys {
  spendingPublicKey: Hex;
  spendingPrivateKey: Hex;
  viewingPublicKey: Hex;
  viewingPrivateKey: Hex;
  /**
   * `st:eth:0x<spendPub><viewPub>`. Stays on the recipient's device, EXCEPT in the opt-in offline CPay QR
   * (`cpay:2:`), where every payer sees it (a stable identifier: disclosed in the UI).
   */
  metaAddressURI: string;
}

/** What the recipient stores locally for each destination it hands out. */
export interface OneTimeDestination {
  address: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
}

/** Derive the recipient's stealth keys from a 65-byte wallet signature over KEY_DERIVATION_MESSAGE. */
export function keysFromSignature(signature: Hex): StealthKeys {
  const k = generateKeysFromSignature(signature);
  const meta = generateStealthMetaAddressFromKeys({
    spendingPublicKey: k.spendingPublicKey,
    viewingPublicKey: k.viewingPublicKey,
  });
  return { ...k, metaAddressURI: `st:eth:${meta}` };
}

function secretKeyBytes(k: Uint8Array | Hex, name: string): Uint8Array {
  const b = typeof k === "string" ? hexToBytes(k.startsWith("0x") ? k.slice(2) : k) : k;
  if (b.length !== 32 || !secp256k1.utils.isValidSecretKey(b)) throw new Error(`stealth: invalid ${name} key`);
  return b;
}

/**
 * Stealth keys from two secp256k1 secret keys (CPay: HKDF from the passkey root, see @cpay/wallet).
 * Same shape as keysFromSignature: compressed public keys, `st:eth:` meta-address.
 */
export function keysFromSeed(spendKey: Uint8Array | Hex, viewKey: Uint8Array | Hex): StealthKeys {
  const spend = secretKeyBytes(spendKey, "spending");
  const view = secretKeyBytes(viewKey, "viewing");
  const spendingPublicKey = `0x${bytesToHex(secp256k1.getPublicKey(spend, true))}` as Hex;
  const viewingPublicKey = `0x${bytesToHex(secp256k1.getPublicKey(view, true))}` as Hex;
  const meta = generateStealthMetaAddressFromKeys({ spendingPublicKey, viewingPublicKey });
  return {
    spendingPublicKey,
    spendingPrivateKey: `0x${bytesToHex(spend)}`,
    viewingPublicKey,
    viewingPrivateKey: `0x${bytesToHex(view)}`,
    metaAddressURI: `st:eth:${meta}`,
  };
}

/**
 * The recipient generates a fresh one-time address to its OWN meta-address with a random ephemeral key.
 * Self-checked with checkStealthAddress. No on-chain announcement is needed.
 */
export function createOneTimeDestination(keys: StealthKeys): OneTimeDestination {
  const r = generateStealthAddress({
    stealthMetaAddressURI: keys.metaAddressURI,
    schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
  });
  const ok = checkStealthAddress({
    userStealthAddress: r.stealthAddress,
    ephemeralPublicKey: r.ephemeralPublicKey,
    viewTag: r.viewTag,
    spendingPublicKey: keys.spendingPublicKey,
    viewingPrivateKey: keys.viewingPrivateKey,
    schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
  });
  if (!ok) throw new Error("stealth: self-check failed for generated destination");
  return { address: getAddress(r.stealthAddress), ephemeralPublicKey: r.ephemeralPublicKey, viewTag: r.viewTag };
}

/** True if `dest` belongs to these keys (view-tag + address check). */
export function ownsDestination(keys: StealthKeys, dest: OneTimeDestination): boolean {
  return checkStealthAddress({
    userStealthAddress: dest.address,
    ephemeralPublicKey: dest.ephemeralPublicKey,
    viewTag: dest.viewTag,
    spendingPublicKey: keys.spendingPublicKey,
    viewingPrivateKey: keys.viewingPrivateKey,
    schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
  });
}

/** Recover the one-time private key. Throws unless it controls exactly `dest.address`. */
export function recoverSpendKey(keys: StealthKeys, dest: OneTimeDestination): Hex {
  const pk = computeStealthKey({
    viewingPrivateKey: keys.viewingPrivateKey,
    spendingPrivateKey: keys.spendingPrivateKey,
    ephemeralPublicKey: dest.ephemeralPublicKey,
    schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
  }) as Hex;
  const derived = privateKeyToAccount(pk).address;
  if (!isAddressEqual(derived, dest.address)) {
    throw new Error("stealth: recovered key does not control the destination");
  }
  return pk;
}

// ---- offline receiving: the payer derives the address from the recipient's meta-address and announces it ----

/**
 * The ERC-5564 singleton Announcer, the same address on every chain (EIP-5564; ScopeLift deployments page lists
 * Base Sepolia). Taken from the ScopeLift SDK, not typed in here.
 */
export const ERC5564_ANNOUNCER: Address = getAddress(ERC5564_CONTRACT_ADDRESS);
export const ANNOUNCER_ABI = ERC5564AnnouncerAbi;
/** First block worth scanning on Base Sepolia (Announcer deployment, from the SDK). */
export const BASE_SEPOLIA_ANNOUNCER_START_BLOCK = BigInt(ERC5564_StartBlocks.BASE_SEPOLIA);
export const SCHEME_ID = 1n;

/** The meta-address's two compressed public keys (132 hex, no 0x), or null if either isn't a valid secp256k1 point. */
export function parseMetaAddress(keysHex: string): { metaAddressURI: string } | null {
  if (!/^[0-9a-f]{132}$/.test(keysHex)) return null;
  try {
    parseKeysFromStealthMetaAddress({ stealthMetaAddress: `0x${keysHex}`, schemeId: VALID_SCHEME_ID.SCHEME_ID_1 });
  } catch {
    return null;
  }
  return { metaAddressURI: `st:eth:0x${keysHex}` };
}

/**
 * Payer: a fresh one-time address for someone else's meta-address (random ephemeral key, SDK). The payer must
 * announce it (announceDestination) or the recipient can't find the payment.
 */
export function destinationForMetaAddress(metaAddressURI: string): OneTimeDestination {
  const r = generateStealthAddress({ stealthMetaAddressURI: metaAddressURI, schemeId: VALID_SCHEME_ID.SCHEME_ID_1 });
  return { address: getAddress(r.stealthAddress), ephemeralPublicKey: r.ephemeralPublicKey, viewTag: r.viewTag };
}

export interface AnnounceParams {
  account: Account;
  destination: OneTimeDestination;
  transport: Transport;
  chain?: Chain;
}

/**
 * Payer: ERC5564Announcer.announce(1, stealthAddress, ephemeralPubKey, metadata = viewTag). Metadata is ONLY the
 * 1-byte view tag (no token or amount): the transfer is public anyway, but we don't add to it. Waits for the receipt.
 */
export async function announceDestination(p: AnnounceParams): Promise<Hex> {
  const chain = p.chain ?? baseSepolia;
  const pub = createPublicClient({ chain, transport: p.transport });
  const wallet = createWalletClient({ account: p.account, chain, transport: p.transport });
  const hash = await wallet.writeContract({
    address: ERC5564_ANNOUNCER,
    abi: ERC5564AnnouncerAbi,
    functionName: "announce",
    args: [SCHEME_ID, getAddress(p.destination.address), p.destination.ephemeralPublicKey, p.destination.viewTag],
    account: p.account,
    chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`announce: reverted (${hash})`);
  return hash;
}

export interface ScanParams extends ChainParams {
  keys: StealthKeys;
  fromBlock: bigint;
  toBlock: bigint;
  /** blocks per eth_getLogs call (public RPCs cap the range) */
  chunk?: bigint;
}

/**
 * Recipient: read every scheme-1 Announcement in [fromBlock, toBlock] and keep the ones our viewing key owns
 * (view tag + address check, SDK). Reads ALL announcements in the range, so the RPC learns only that this IP scans.
 */
export async function scanAnnouncements(p: ScanParams): Promise<OneTimeDestination[]> {
  const chain = p.chain ?? baseSepolia;
  const pub = createPublicClient({ chain, transport: p.transport });
  const chunk = p.chunk ?? 5_000n;
  const mine: OneTimeDestination[] = [];
  for (let from = p.fromBlock; from <= p.toBlock; from += chunk) {
    const to = from + chunk - 1n < p.toBlock ? from + chunk - 1n : p.toBlock;
    const logs = await pub.getContractEvents({
      address: ERC5564_ANNOUNCER,
      abi: ERC5564AnnouncerAbi,
      eventName: "Announcement",
      args: { schemeId: SCHEME_ID },
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    for (const l of logs) {
      const { stealthAddress, ephemeralPubKey, metadata } = l.args;
      if (!stealthAddress || !ephemeralPubKey || !metadata || metadata.length < 4) continue;
      const dest: OneTimeDestination = {
        address: getAddress(stealthAddress),
        ephemeralPublicKey: ephemeralPubKey,
        viewTag: `0x${metadata.slice(2, 4)}` as Hex,
      };
      try {
        if (ownsDestination(p.keys, dest)) mine.push(dest);
      } catch {
        /* malformed announcement from someone else */
      }
    }
  }
  return mine;
}

export interface ChainParams {
  /** e.g. `http(SEPOLIA_RPC_URL)` */
  transport: Transport;
  /** defaults to Base Sepolia */
  chain?: Chain;
}

export interface PayParams extends ChainParams {
  /** The agent wallet. */
  account: Account;
  destination: Address;
  /** token base units */
  amount: bigint;
  gasDropWei?: bigint;
  /** defaults to Base Sepolia USDC */
  token?: Address;
}

export interface PayResult {
  transferHash: Hex;
  gasDropHash: Hex | null;
}

/**
 * ERC-20 transfer + a separate ETH gas drop to the one-time address, both signed by `account`.
 * Pre-checks balances, waits for each receipt and throws on revert.
 */
export async function payToDestination(p: PayParams): Promise<PayResult> {
  const chain = p.chain ?? baseSepolia;
  const token = p.token ?? BASE_SEPOLIA_USDC;
  const gasDropWei = p.gasDropWei ?? DEFAULT_GAS_DROP_WEI;
  if (p.amount <= 0n) throw new Error("pay: amount must be positive");
  if (gasDropWei < 0n) throw new Error("pay: negative gas drop");
  const destination = getAddress(p.destination);

  const pub = createPublicClient({ chain, transport: p.transport });
  const wallet = createWalletClient({ account: p.account, chain, transport: p.transport });

  const [tokenBal, ethBal] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [p.account.address] }),
    pub.getBalance({ address: p.account.address }),
  ]);
  if (tokenBal < p.amount) throw new Error("pay: insufficient token balance");
  if (ethBal <= gasDropWei) throw new Error("pay: insufficient ETH for gas drop + fees");

  const transferHash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [destination, p.amount],
    account: p.account,
    chain,
  });
  const r1 = await pub.waitForTransactionReceipt({ hash: transferHash });
  if (r1.status !== "success") throw new Error(`pay: token transfer reverted (${transferHash})`);

  let gasDropHash: Hex | null = null;
  if (gasDropWei > 0n) {
    gasDropHash = await wallet.sendTransaction({ to: destination, value: gasDropWei, account: p.account, chain });
    const r2 = await pub.waitForTransactionReceipt({ hash: gasDropHash });
    if (r2.status !== "success") throw new Error(`pay: gas drop reverted (${gasDropHash})`);
  }
  return { transferHash, gasDropHash };
}

export interface SweepParams extends ChainParams {
  /** from recoverSpendKey */
  stealthPrivateKey: Hex;
  to: Address;
  token?: Address;
}

/** Move the one-time address's full token balance to `to`, paying gas from the gas drop. */
export async function sweep(p: SweepParams): Promise<{ hash: Hex; amount: bigint }> {
  return sendFromOneTime({ ...p, amount: "all" });
}

export interface SendFromOneTimeParams extends SweepParams {
  /** token base units, or "all" for the full balance */
  amount: bigint | "all";
}

/**
 * Token transfer signed by the one-time key itself (gas from its gas drop). Nothing else signs, so the
 * transfer touches no other wallet. Checks the balance first, waits for the receipt, throws on revert.
 */
export async function sendFromOneTime(p: SendFromOneTimeParams): Promise<{ hash: Hex; amount: bigint }> {
  const chain = p.chain ?? baseSepolia;
  const token = p.token ?? BASE_SEPOLIA_USDC;
  const account = privateKeyToAccount(p.stealthPrivateKey);
  const pub = createPublicClient({ chain, transport: p.transport });
  const wallet = createWalletClient({ account, chain, transport: p.transport });

  const balance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const amount = p.amount === "all" ? balance : p.amount;
  if (amount <= 0n) throw new Error(p.amount === "all" ? "sweep: nothing to sweep" : "send: amount must be positive");
  if (balance < amount) throw new Error("send: insufficient token balance on the one-time address");
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(p.to), amount],
    account,
    chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`send: transfer reverted (${hash})`);
  return { hash, amount };
}

/** Gas for a plain ETH transfer to an EOA. */
const ETH_TRANSFER_GAS = 21_000n;

/**
 * Move what is left of the gas drop to `to` (a plain transfer, so it links the one-time address to `to` just
 * like a token sweep does). Sends balance - fee budget; the budget is gas * maxFeePerGas plus, on OP-stack
 * chains (Base), twice the estimated L1 data fee. The unused part of that budget (a few gwei-scale wei) stays
 * behind as dust: an EOA can't pay a fee it can't know exactly in advance. Returns null if nothing is worth
 * moving.
 */
export async function sweepEth(p: ChainParams & { stealthPrivateKey: Hex; to: Address }): Promise<{ hash: Hex; amount: bigint } | null> {
  const chain = p.chain ?? baseSepolia;
  const account = privateKeyToAccount(p.stealthPrivateKey);
  const pub = createPublicClient({ chain, transport: p.transport });
  const wallet = createWalletClient({ account, chain, transport: p.transport });
  const to = getAddress(p.to);

  const [balance, fees] = await Promise.all([pub.getBalance({ address: account.address }), pub.estimateFeesPerGas()]);
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  let budget = ETH_TRANSFER_GAS * maxFeePerGas;
  if (chain.sourceId !== undefined) {
    // OP-stack: the sender also pays an L1 data fee that the node checks against the balance.
    const l1 = await estimateL1Fee(pub as never, { account, to, value: balance, chain, gas: ETH_TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas });
    budget += 2n * l1;
  }
  if (balance <= budget) return null;
  const amount = balance - budget;
  const hash = await wallet.sendTransaction({ account, chain, to, value: amount, gas: ETH_TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`sweepEth: transfer reverted (${hash})`);
  return { hash, amount };
}
