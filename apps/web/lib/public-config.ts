// Browser-visible configuration. Only NEXT_PUBLIC_* values, never a secret.
// Each var is read with a literal `process.env.NEXT_PUBLIC_X` so Next inlines it at build time.

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const publicConfig = {
  relayUrl: process.env.NEXT_PUBLIC_RELAY_URL ?? "",
  issuerUrl: (process.env.NEXT_PUBLIC_ISSUER_URL ?? "").replace(/\/$/, ""),
  bridgeWsUrl: process.env.NEXT_PUBLIC_BRIDGE_WS_URL ?? "",
  worldAppId: process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "",
  worldAction: process.env.NEXT_PUBLIC_WORLD_ACTION ?? "cpay-recipient-v1",
  worldEnvironment: (process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT === "production" ? "production" : "staging") as
    | "production"
    | "staging",
  chainId: num(process.env.NEXT_PUBLIC_CHAIN_ID, 84532),
  usdcAddress: process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  faceMatchThreshold: num(process.env.NEXT_PUBLIC_FACE_MATCH_THRESHOLD, 0.6),
  /** World ID tier a private recipient must prove before we pay (verifyClaim2 returns it unchecked). */
  requiredTier: process.env.NEXT_PUBLIC_REQUIRED_TIER || "orb",
  claimTimeoutMs: num(process.env.NEXT_PUBLIC_CLAIM_TIMEOUT_MS, 4000),
  paymentCapDisplay: process.env.NEXT_PUBLIC_AGENT_PAYMENT_CAP_USDC ?? "",
  dailyCapDisplay: process.env.NEXT_PUBLIC_AGENT_DAILY_CAP_USDC ?? "",
} as const;

export const ETHERSCAN_TX = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const ETHERSCAN_ADDR = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
