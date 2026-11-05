import { formatUnits, parseUnits } from "viem";

export type Token = "USDC";
export const TOKENS: readonly Token[] = ["USDC"];
export const USDC_DECIMALS = 6;

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Strict decimal USDC amount -> base units. Rejects signs, exponents, spaces, more than 6 decimals
 * (never rounds) and anything that isn't a plain decimal. `allowZero` for caps and ledgers.
 */
export function toBaseUnits(amount: string, opts: { allowZero?: boolean } = {}): bigint | null {
  if (typeof amount !== "string" || !DECIMAL.test(amount)) return null;
  const frac = amount.split(".")[1];
  if (frac !== undefined && frac.length > USDC_DECIMALS) return null;
  const v = parseUnits(amount, USDC_DECIMALS);
  if (v < 0n || (v === 0n && !opts.allowZero)) return null;
  return v;
}

export function fromBaseUnits(v: bigint): string {
  return formatUnits(v, USDC_DECIMALS);
}
