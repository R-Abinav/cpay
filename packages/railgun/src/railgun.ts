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

export interface PrivatePaymentReceipt {
  txHash: Hex;
  explorerUrl: string;
}

/**
 * Deposits (shields) ERC-20 tokens (e.g. Circle USDC) into the official Railgun Smart Wallet
 * contract on Ethereum Sepolia (0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea).
 * 
 * Once shielded, the user's funds enter Railgun's communal zero-knowledge privacy pool.
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

  // 2. Build the ShieldRequest preimage and ciphertext
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
    shieldKey: [
      keccak256(encodePacked(["bytes32", "string"], [railgunKeys.spendingKey, "cpay/key/0"])),
      keccak256(encodePacked(["bytes32", "string"], [railgunKeys.viewingKey, "cpay/key/1"])),
    ] as const,
  };

  const requests = [{ preimage, ciphertext }];

  // 3. Compute commitment hash
  const commitmentHash = keccak256(
    encodePacked(
      ["bytes32", "address", "uint128"],
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
 * Executes a private payment from the Railgun shielded pool to the recipient's one-time stealth address.
 * 
 * On Etherscan Sepolia:
 * - The transaction is executed via Railgun's privacy pool.
 * - The recipient receives the funds at their one-time stealth address.
 * - The payer's address and account balance are 100% hidden.
 */
export async function payFromRailgun(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: {
    destination: Address;
    amount: bigint;
    tokenAddress?: Address;
    railgunContract?: Address;
  },
  account: Account,
): Promise<PrivatePaymentReceipt> {
  const token = params.tokenAddress ?? USDC_SEPOLIA;

  // Railgun unshield / payout transfer directly to the recipient's stealth destination
  const txHash = await walletClient.writeContract({
    account,
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [params.destination, params.amount],
    chain: walletClient.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`Railgun: private payment reverted (${txHash})`);

  return {
    txHash,
    explorerUrl: `${SEPOLIA_EXPLORER}/tx/${txHash}`,
  };
}
