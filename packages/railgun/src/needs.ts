// What a private payment spends from the shielded balance (pure; tested). Kohaku adds the unshield fee on
// top so the recipient gets exactly the amount; the paymaster fee comes out of shielded WETH.
import type { PrivateBalances } from "./types.js";

const BPS = 10_000n;
/** Railgun's unshield fee on Sepolia and mainnet (chainConfig().unshieldFeeBps). */
export const UNSHIELD_FEE_BPS = 25;
/**
 * Paymaster fee reserve in WETH. Measured on Sepolia: ~0.0028 ETH per 4337 unshield at ~1.1 gwei
 * (2.5M gas); a higher reserve fails closed (the payment goes public with consent) instead of reverting.
 */
export const FEE_RESERVE_WEI = 4_000_000_000_000_000n; // 0.004 WETH

/** Gross amount unshielded so that `net` arrives after the fee (same formula as Kohaku). */
export function grossOf(net: bigint, feeBps = UNSHIELD_FEE_BPS): bigint {
  return (net * BPS) / (BPS - BigInt(feeBps));
}

export interface PrivateNeeds {
  /** USDC (6 decimals) incl. the unshield fee */
  usdc: bigint;
  /** WETH: paymaster fee reserve + the gross gas drop */
  weth: bigint;
}

export function privateNeeds(p: { amount: bigint; gasDropWei?: bigint; feeBps?: number; feeReserveWei?: bigint }): PrivateNeeds {
  if (p.amount <= 0n) throw new Error("railgun: amount must be positive");
  const drop = p.gasDropWei ?? 0n;
  if (drop < 0n) throw new Error("railgun: gas drop must not be negative");
  return {
    usdc: grossOf(p.amount, p.feeBps),
    weth: (p.feeReserveWei ?? FEE_RESERVE_WEI) + (drop > 0n ? grossOf(drop, p.feeBps) : 0n),
  };
}

export type CanPay = { ok: true } | { ok: false; reason: "usdc" | "weth" };

/** Only POI-Valid notes count; pending never does. */
export function canPayFrom(bal: PrivateBalances, needs: PrivateNeeds): CanPay {
  if (bal.usdc.valid < needs.usdc) return { ok: false, reason: "usdc" };
  if (bal.weth.valid < needs.weth) return { ok: false, reason: "weth" };
  return { ok: true };
}
