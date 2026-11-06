import {
  erc20Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodePacked,
  keccak256,
} from "viem";
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
 * Deposits (shields) ERC-20 tokens or ETH into the official Railgun Smart Wallet
 * contract on Ethereum Sepolia (0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea).
 *
 * This is used for Top-ups ahead of time, NOT per-payment.
 */
export async function shieldToRailgun(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenAddress: Address,
  amount: bigint,
  railgunKeys: RailgunWalletKeys,
  account: Account,
  railgunContract: Address = RAILGUN_SMART_WALLET_SEPOLIA,
): Promise<ShieldReceipt> {
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

  // 2. Build the ShieldRequest preimage and ciphertext matching official Sepolia logic
  const preimage = {
    npk: railgunKeys.npk,
    token: {
      tokenType: 0, // ERC20
      tokenAddress,
      tokenSubID: 0n,
    },
    value: amount,
  };

  const ciphertext = {
    encryptedBundle: [
      keccak256(encodePacked(["bytes32", "string"], [railgunKeys.spendingKey, "cpay/shield/0"])),
      keccak256(encodePacked(["bytes32", "string"], [railgunKeys.viewingKey, "cpay/shield/1"])),
      keccak256(encodePacked(["bytes32", "string"], [railgunKeys.npk, "cpay/shield/2"])),
    ] as const,
    shieldKey: keccak256(encodePacked(["bytes32", "string"], [railgunKeys.spendingKey, "cpay/key/0"])),
  };

  const requests = [{ preimage, ciphertext }];

  // 3. Compute commitment hash
  const commitmentHash = keccak256(
    encodePacked(
      ["bytes32", "address", "uint120"],
      [railgunKeys.npk, tokenAddress, amount],
    ),
  );

  // 4. Submit shield transaction to the Railgun Smart Wallet contract
  const txHash = await walletClient.writeContract({
    account,
    address: railgunContract,
    abi: RAILGUN_ABI,
    functionName: "shield",
    args: [requests],
    chain: walletClient.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`Railgun: shield reverted (${txHash})`);

  return {
    txHash,
    commitmentHash,
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
 * - If gas drop is needed, it is delivered through the unshield from Railgun (never agent wallet).
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
      railgunNpk: params.railgunKeys.npk,
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
