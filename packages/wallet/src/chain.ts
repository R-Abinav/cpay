// Chain config, balances and direct USDC payments. Signing happens here, in the browser, with the
// passkey-derived LocalAccount. There is no server signer.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  isAddress,
  type Chain,
} from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import {
  broadcastUnshield,
  shieldToRailgun,
  type RailgunWalletKeys,
} from "@cpay/railgun";
import { toBaseUnits, type Token } from "./amount.js";
import type { WalletHandle } from "./passkey.js";

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  usdc: `0x${string}`;
  railgunAddress?: `0x${string}`;
  explorerUrl: string;
}

const DEFAULTS: ChainConfig = {
  chainId: 11155111,
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  railgunAddress: "0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea",
  explorerUrl: "https://sepolia.etherscan.io",
};

/**
 * Reads NEXT_PUBLIC_* config. Each variable is referenced literally so Next inlines it into the
 * browser bundle; the try/catch covers runtimes without `process`.
 */
export function chainFromEnv(): ChainConfig {
  let e: Record<string, string | undefined> = {};
  try {
    e = {
      chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
      rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
      usdc: process.env.NEXT_PUBLIC_USDC_ADDRESS,
      railgunAddress: process.env.NEXT_PUBLIC_RAILGUN_ADDRESS,
      explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL,
    };
  } catch {
    // no process.env: defaults
  }
  const chainId = e.chainId ? Number(e.chainId) : DEFAULTS.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("wallet: bad NEXT_PUBLIC_CHAIN_ID");
  const usdc = (e.usdc || DEFAULTS.usdc) as `0x${string}`;
  if (!isAddress(usdc)) throw new Error("wallet: bad NEXT_PUBLIC_USDC_ADDRESS");
  const railgunAddress = (e.railgunAddress || DEFAULTS.railgunAddress) as `0x${string}`;
  return {
    chainId,
    rpcUrl: e.rpcUrl || DEFAULTS.rpcUrl,
    usdc,
    railgunAddress,
    explorerUrl: (e.explorerUrl || DEFAULTS.explorerUrl).replace(/\/+$/, ""),
  };
}

export function chainOf(cfg: ChainConfig): Chain {
  if (cfg.chainId === sepolia.id) return { ...sepolia, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  if (cfg.chainId === baseSepolia.id) return { ...baseSepolia, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  return defineChain({
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    testnet: true,
  });
}

function publicClient(cfg: ChainConfig) {
  return createPublicClient({ chain: chainOf(cfg), transport: http(cfg.rpcUrl, { timeout: 15_000 }) });
}

export async function balances(cfg: ChainConfig, address: `0x${string}`): Promise<{ eth: bigint; usdc: bigint }> {
  const pc = publicClient(cfg);
  const [eth, usdc] = await Promise.all([
    pc.getBalance({ address }),
    pc.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  return { eth, usdc };
}

export function txUrl(cfg: ChainConfig, txHash: `0x${string}`): string {
  return `${cfg.explorerUrl}/tx/${txHash}`;
}

/**
 */
/**
 * Shields USDC from the agent wallet into the official Railgun Smart Wallet on Ethereum Sepolia.
 * This is used for Top-ups ahead of time, NOT per-payment.
 */
export async function shieldAgentToRailgun(
  cfg: ChainConfig,
  w: WalletHandle,
  amountStr: string,
): Promise<{ txHash: `0x${string}`; explorerUrl: string }> {
  const value = toBaseUnits(amountStr);
  if (value === null) throw new Error("wallet: invalid amount");
  const pc = publicClient(cfg);
  const wc = createWalletClient({ account: w.account, chain: chainOf(cfg), transport: http(cfg.rpcUrl, { timeout: 15_000 }) });
  const railgunAddress: `0x${string}` = cfg.railgunAddress ?? DEFAULTS.railgunAddress!;
  const railgunKeys = w.keys.railgunKeys;

  const res = await shieldToRailgun(wc, pc, cfg.usdc, value, railgunKeys, w.account, railgunAddress);
  return { txHash: res.txHash, explorerUrl: res.explorerUrl };
}

/** Top-up helper alias */
export const topUpRailgun = shieldAgentToRailgun;

/** Returns only a fresh, POI-spendable USDC balance from a completed Railgun scan. */
export async function railgunSpendableUSDC(w: WalletHandle): Promise<{ balance: bigint; scannedAt: number } | null> {
  const { getSpendableUSDC } = await import("@cpay/railgun/browser-engine");
  return getSpendableUSDC(w.keys.railgunKeys);
}

/**
 * Pays a recipient (one-time stealth address or plain address) via Railgun unshielding through a Broadcaster.
 * 
 * The Railgun unshield is submitted by the Broadcaster, not the agent wallet. The destination
 * should be a fresh one-time stealth address; public amounts and timing can still support correlation.
 */
export async function payFromRailgunToStealth(
  cfg: ChainConfig,
  w: WalletHandle,
  p: { destination: `0x${string}`; amount: string; gasDropWei?: bigint; broadcasterUrl?: string },
): Promise<{ txHash: `0x${string}`; explorerUrl: string; gasDropHash: `0x${string}` | null; gasDropError: string | null }> {
  const value = toBaseUnits(p.amount);
  if (value === null) throw new Error("wallet: invalid amount");
  const railgunKeys = w.keys.railgunKeys;

  const res = await broadcastUnshield({
    destination: p.destination,
    amount: value,
    tokenAddress: cfg.usdc,
    gasDropWei: p.gasDropWei,
    railgunKeys,
    broadcasterUrl: p.broadcasterUrl,
  });
  return { txHash: res.txHash, explorerUrl: res.explorerUrl, gasDropHash: res.gasDropHash, gasDropError: res.gasDropError };
}
