// Token registry + exact decimal <-> base-unit conversion (no floats).

export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

/** Tokens the app knows. The policy allow-list (server env) narrows this further. */
export function knownTokens(usdcAddress: string): TokenInfo[] {
  return [{ symbol: "USDC", address: usdcAddress as `0x${string}`, decimals: 6 }];
}

export function findToken(tokens: readonly TokenInfo[], symbolOrAddress: string): TokenInfo | null {
  const q = symbolOrAddress.trim();
  return (
    tokens.find((t) => t.symbol.toUpperCase() === q.toUpperCase() || t.address.toLowerCase() === q.toLowerCase()) ?? null
  );
}

const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]+)?$/;

/** "2.5" with 6 decimals -> 2500000n. Rejects signs, exponents, too many decimals and anything else. */
export function parseAmount(value: string, decimals: number): bigint {
  const v = value.trim();
  if (!DECIMAL.test(v)) throw new Error(`amount: not a plain decimal: ${JSON.stringify(value)}`);
  const [whole, frac = ""] = v.split(".") as [string, string?];
  const f = (frac ?? "").replace(/0+$/, "");
  if (f.length > decimals) throw new Error(`amount: more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((f || "0").padEnd(decimals, "0"));
}

/** 2500000n with 6 decimals -> "2.5" */
export function formatAmount(base: bigint, decimals: number): string {
  if (base < 0n) throw new Error("amount: negative");
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = (base % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
