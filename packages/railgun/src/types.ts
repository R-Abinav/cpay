// Public interface of @cpay/railgun (a contract with apps/web; change only in its own commit).

export interface RailgunStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface RailgunConfig {
  /** 32 bytes: deriveKeys(root).railgunSeed. Never leaves the device. */
  seed: Uint8Array;
  chainId: number;
  rpcUrl: string;
  usdc: `0x${string}`;
  weth: `0x${string}`;
  /** our own origin, e.g. "/railgun-artifacts/" */
  artifactsBase: string;
  /** our own origin, e.g. "/railgun/kohaku_bg.wasm" */
  wasmUrl: string;
  /** our JSON-RPC proxy to the 4337 bundler, e.g. "/api/bundler" */
  bundlerUrl: string;
  storage: RailgunStorage;
}

export interface TxData {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

/** pending = POI not yet Valid */
export type NoteStatus = "valid" | "pending";

export interface PrivateBalances {
  usdc: { valid: bigint; pending: bigint };
  weth: { valid: bigint; pending: bigint };
}

export interface RailgunClient {
  /** real 0zk address */
  address(): string;
  /** incremental; safe to call often; rescans the last ~50 blocks */
  sync(): Promise<void>;
  balances(): Promise<PrivateBalances>;
  /** [wrap?, approve?, shield] for the agent wallet (phone) to sign */
  prepareShield(p: { token: "USDC" | "WETH"; amount: bigint; from: `0x${string}` }): Promise<TxData[]>;
  /**
   * Whether the POI-valid balance covers a payment right now (no sync): USDC incl. the 0.25% unshield
   * fee, and WETH for the paymaster fee reserve plus the gross gas drop.
   */
  canPay(p: { amount: bigint; gasDropWei?: bigint }): Promise<{ ok: true } | { ok: false; reason: "usdc" | "weth" }>;
  /**
   * USDC unshield to `to` via ERC-4337; returns the on-chain tx hash; throws (no fallback) on failure.
   * With `gasDropWei`, the same UserOperation also delivers that much native ETH to `to`, unwrapped
   * from the shielded WETH (for one-time recipient addresses).
   */
  pay(p: {
    amount: bigint;
    to: `0x${string}`;
    gasDropWei?: bigint;
    onStage?: (s: "proving" | "submitting" | "confirming") => void;
  }): Promise<{ txHash: `0x${string}` }>;
}
