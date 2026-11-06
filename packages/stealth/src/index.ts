// Recipient-generated ERC-5564 (scheme 1, secp256k1) one-time addresses on top of the ScopeLift SDK,
// plus pay (USDC transfer + ETH gas drop) and sweep. No EC maths here; the SDK and viem do it.
//
// This package never reads env vars or keys itself. Callers pass a viem Account (the agent wallet
// for pay, the recovered one-time key for sweep) and a transport.
import {
  VALID_SCHEME_ID,
  checkStealthAddress,
  computeStealthKey,
  generateKeysFromSignature,
  generateStealthAddress,
  generateStealthMetaAddressFromKeys,
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
import { sepolia } from "viem/chains";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Circle testnet USDC on Ethereum Sepolia (11155111), the CPay payment chain. */
export const SEPOLIA_USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
/** Alias for default CPay testnet USDC. */
export const DEFAULT_USDC = SEPOLIA_USDC;
/** Circle testnet USDC on Base Sepolia (84532) for legacy compatibility. */
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
  /** `st:eth:0x<spendPub><viewPub>`. Stays on the recipient's device; the payer never sees it. */
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
  const chain = p.chain ?? sepolia;
  const token = p.token ?? SEPOLIA_USDC;
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
  const chain = p.chain ?? sepolia;
  const token = p.token ?? SEPOLIA_USDC;
  const account = privateKeyToAccount(p.stealthPrivateKey);
  const pub = createPublicClient({ chain, transport: p.transport });
  const wallet = createWalletClient({ account, chain, transport: p.transport });

  const amount = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (amount === 0n) throw new Error("sweep: nothing to sweep");
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(p.to), amount],
    account,
    chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`sweep: transfer reverted (${hash})`);
  return { hash, amount };
}
