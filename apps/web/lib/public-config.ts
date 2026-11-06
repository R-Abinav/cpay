// Browser-visible configuration. Only NEXT_PUBLIC_* values, never a secret.
// Each var is read with a literal `process.env.NEXT_PUBLIC_X` so Next inlines it at build time.

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Default ETH dropped to a one-time address so it can move its USDC later (0.0005 ETH; Sepolia L1 gas). */
export const DEFAULT_GAS_DROP_WEI = 500_000_000_000_000n;

/** Gas drop in wei. Unset, invalid or 0 -> default: a one-time address without gas can't move its funds. */
export function parseGasDropWei(v: string | undefined): bigint {
  const t = (v ?? "").trim();
  if (!/^\d+$/.test(t)) return DEFAULT_GAS_DROP_WEI;
  const n = BigInt(t);
  return n > 0n ? n : DEFAULT_GAS_DROP_WEI;
}

function worldEnvs(list: string | undefined, single: string | undefined): ("production" | "staging")[] {
  const raw = (list || single || "staging").split(",").map((e) => e.trim());
  const out = (["production", "staging"] as const).filter((e) => raw.includes(e));
  return out.length ? [...out] : ["staging"];
}

export const publicConfig = {
  relayUrl: process.env.NEXT_PUBLIC_RELAY_URL ?? "",
  issuerUrl: (process.env.NEXT_PUBLIC_ISSUER_URL ?? "").replace(/\/$/, ""),
  /** Optional build-time pin of the issuer BBS public key (public). Unset -> fetched once at app start. */
  issuerPublicKey: (process.env.NEXT_PUBLIC_ISSUER_BBS_PUBLIC_KEY ?? "").trim(),
  worldAppId: process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "",
  worldAction: process.env.NEXT_PUBLIC_WORLD_ACTION ?? "cpay-recipient-v1",
  worldEnvironment: (process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT === "production" ? "production" : "staging") as
    | "production"
    | "staging",
  /** Every World environment the issuer accepts (NEXT_PUBLIC_WORLD_ENVIRONMENTS, comma-separated). Production is the main button; staging is the testing fallback. */
  worldEnvironments: worldEnvs(process.env.NEXT_PUBLIC_WORLD_ENVIRONMENTS, process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT),
  chainId: num(process.env.NEXT_PUBLIC_CHAIN_ID, 11155111),
  usdcAddress: process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  gasDropWei: parseGasDropWei(process.env.NEXT_PUBLIC_GAS_DROP_WEI),
  faceMatchThreshold: num(process.env.NEXT_PUBLIC_FACE_MATCH_THRESHOLD, 0.4),
  /** World ID tier a private recipient must prove before we pay (verifyClaim2 returns it unchecked). */
  requiredTier: process.env.NEXT_PUBLIC_REQUIRED_TIER || "orb",
  claimTimeoutMs: num(process.env.NEXT_PUBLIC_CLAIM_TIMEOUT_MS, 4000),
  paymentCapDisplay: process.env.NEXT_PUBLIC_AGENT_PAYMENT_CAP_USDC ?? "",
  dailyCapDisplay: process.env.NEXT_PUBLIC_AGENT_DAILY_CAP_USDC ?? "",
} as const;

export const ETHERSCAN_TX = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const ETHERSCAN_ADDR = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
