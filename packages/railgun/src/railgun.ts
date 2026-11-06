import {
  erc20Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  getAddress,
} from "viem";
import {
  RailgunEngine,
  ShieldNoteERC20,
  ByteUtils,
} from "@railgun-community/engine";
import {
  RAILGUN_ABI,
  RAILGUN_SMART_WALLET_SEPOLIA,
  SEPOLIA_EXPLORER,
  USDC_SEPOLIA,
} from "./constants.js";
import type { RailgunWalletKeys } from "./keys.js";

export interface ShieldReceipt {
  txHash: Hex;
  commitmentHash: Hex;
  explorerUrl: string;
}

export interface BroadcastUnshieldParams {
  destination: Address;
  amount: bigint;
  tokenAddress?: Address;
  gasDropWei?: bigint;
  railgunKeys: RailgunWalletKeys;
  broadcasterUrl?: string;
}

export interface BroadcastResult {
  txHash: Hex;
  explorerUrl: string;
  fromBroadcaster: Address;
  gasPaidByBroadcaster: boolean;
}

/**
 * Deposits (shields) ERC-20 tokens into the official Railgun Smart Wallet
 * contract on Ethereum Sepolia (0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea).
 *
 * Uses real Railgun cryptographic note encryption (ECDH shared symmetric key,
 * AES-GCM random encryption, AES-CTR receiver viewing key encryption, and Poseidon note commitment).
 *
 * This is used for Top-ups ahead of time, NOT per-payment.
 */
export async function shieldToRailgun(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenAddress: Address,
  amount: bigint,
  recipientAddressOrKeys: string | RailgunWalletKeys,
  account: Account,
  railgunContract: Address = RAILGUN_SMART_WALLET_SEPOLIA,
): Promise<ShieldReceipt> {
  const recipient0zk = typeof recipientAddressOrKeys === "string" 
    ? recipientAddressOrKeys 
    : recipientAddressOrKeys.railgunAddress;

  // 1. Ensure token allowance for Railgun Smart Wallet
  const currentAllowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, railgunContract],
  })) as bigint;

  if (currentAllowance < amount) {
    const approveTx = await walletClient.writeContract({
      account,
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [railgunContract, amount * 100n],
      chain: walletClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // 2. Decode official Railgun 0zk recipient address
  const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(recipient0zk);
  const random = ByteUtils.randomHex(16);

  // 3. Create and serialize official ShieldNoteERC20 with real cryptography
  const shieldNote = new ShieldNoteERC20(masterPublicKey, random, amount, getAddress(tokenAddress));
  const shieldPrivateKey = ByteUtils.randomHex(32);
  const serialized = await shieldNote.serialize(ByteUtils.hexToBytes(shieldPrivateKey), viewingPublicKey);

  const request = {
    preimage: {
      npk: serialized.preimage.npk as Hex,
      token: {
        tokenType: Number(serialized.preimage.token.tokenType),
        tokenAddress: getAddress(String(serialized.preimage.token.tokenAddress)),
        tokenSubID: BigInt(serialized.preimage.token.tokenSubID || "0"),
      },
      value: BigInt(serialized.preimage.value),
    },
    ciphertext: {
      encryptedBundle: serialized.ciphertext.encryptedBundle as readonly [Hex, Hex, Hex],
      shieldKey: serialized.ciphertext.shieldKey as Hex,
    },
  };

  // 4. Submit shield transaction to the Railgun Smart Wallet contract
  const txHash = await walletClient.writeContract({
    account,
    address: railgunContract,
    abi: RAILGUN_ABI,
    functionName: "shield",
    args: [[request]],
    chain: walletClient.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`Railgun: shield reverted (${txHash})`);

  return {
    txHash,
    commitmentHash: request.preimage.npk,
    explorerUrl: `${SEPOLIA_EXPLORER}/tx/${txHash}`,
  };
}

/**
 * Recipient moves private funds from a one-time stealth address into their own Railgun wallet.
 *
 * The one-time address signs an approval and shield() call to Railgun Smart Wallet.
 * Once shielded, the funds enter the communal zero-knowledge pool under the recipient's 0zk address.
 */
export async function shieldFromOneTime(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenAddress: Address,
  amount: bigint,
  recipientRailgunKeys: RailgunWalletKeys,
  oneTimeAccount: Account,
  railgunContract: Address = RAILGUN_SMART_WALLET_SEPOLIA,
): Promise<ShieldReceipt> {
  return shieldToRailgun(
    walletClient,
    publicClient,
    tokenAddress,
    amount,
    recipientRailgunKeys,
    oneTimeAccount,
    railgunContract,
  );
}

/**
 * Broadcasts an unshield transaction from Railgun straight to the recipient's destination
 * (one-time stealth address or plain address).
 *
 * Crucial privacy guarantees:
 * - The transaction is broadcast by a Broadcaster (relayer).
 * - The agent wallet NEVER pays gas and NEVER appears as tx.origin or sender.
 * - If gas drop is needed, it is delivered through the broadcaster (never agent wallet).
 * - If Railgun or Broadcaster fails, stops visibly without fallback (no mocks).
 */
export async function broadcastUnshield(
  params: BroadcastUnshieldParams,
): Promise<BroadcastResult> {
  const url = params.broadcasterUrl || "/api/railgun/broadcast";
  const token = params.tokenAddress ?? USDC_SEPOLIA;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      destination: params.destination,
      amount: params.amount.toString(),
      token,
      gasDropWei: params.gasDropWei ? params.gasDropWei.toString() : "0",
      mnemonic: params.railgunKeys.mnemonic,
      railgunAddress: params.railgunKeys.railgunAddress,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Railgun Broadcaster failed: ${errData.error || res.statusText}`);
  }

  const data = await res.json();
  return {
    txHash: data.txHash as Hex,
    explorerUrl: `${SEPOLIA_EXPLORER}/tx/${data.txHash}`,
    fromBroadcaster: data.broadcaster as Address,
    gasPaidByBroadcaster: true,
  };
}
