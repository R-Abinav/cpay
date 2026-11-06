// TYPES ONLY: the interface the real `@cpay/railgun` package implements (built in parallel on `railgun-real`).
// No behaviour lives here. lib/railgun.ts imports the runtime `initRailgun` dynamically from "@cpay/railgun" and
// checks it exists; if it doesn't, the app shows "Private payments unavailable" (never a fake balance).
// At merge, these can become `export type { ... } from "@cpay/railgun"`.

export interface RailgunStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface RailgunConfig {
  seed: Uint8Array;
  chainId: number;
  rpcUrl: string;
  usdc: `0x${string}`;
  weth: `0x${string}`;
  artifactsBase: string;
  wasmUrl: string;
  bundlerUrl: string;
  storage: RailgunStorage;
}

export interface TxData {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

export interface PrivateBalances {
  usdc: { valid: bigint; pending: bigint };
  weth: { valid: bigint; pending: bigint };
}

export type PrivatePayStage = "proving" | "submitting" | "confirming";

export interface RailgunClient {
  address(): string;
  sync(): Promise<void>;
  balances(): Promise<PrivateBalances>;
  prepareShield(p: { token: "USDC" | "WETH"; amount: bigint; from: `0x${string}` }): Promise<TxData[]>;
  pay(p: { amount: bigint; to: `0x${string}`; onStage?: (s: PrivatePayStage) => void }): Promise<{ txHash: `0x${string}` }>;
}

export type InitRailgun = (cfg: RailgunConfig) => Promise<RailgunClient>;
