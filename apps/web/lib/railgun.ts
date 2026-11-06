"use client";
// Railgun private balance (payer hiding), on this phone. One client per unlocked wallet, made from the wallet's
// Railgun seed (derived from the passkey here; never logged or sent). Its local state (merkle tree, notes) is
// kept in the encrypted on-device vault. The runtime comes from "@cpay/railgun" by dynamic import: if that
// package or its `initRailgun` isn't there, the state is "unavailable" and the UI says so (never a fake balance).
import { publicConfig } from "./public-config.js";
import type { PrivateBalances, RailgunClient, RailgunConfig, RailgunStorage } from "./railgun-types.js";
import { vaultGet, vaultSet } from "./vault.js";
import { chain, onWallet, railgunSeedOf, type UnlockedWallet } from "./wallet.js";

export type { PrivateBalances, PrivatePayStage, RailgunClient } from "./railgun-types.js";

export const WETH_ADDRESS = (process.env.NEXT_PUBLIC_WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14") as `0x${string}`;
/** WETH kept shielded to pay the broadcaster fee on private payments. */
export const WETH_FEE_TOPUP = 2_000_000_000_000_000n; // 0.002 WETH
export const WETH_FEE_LOW = 1_000_000_000_000_000n; // top up below 0.001 WETH (valid + pending)

export interface RailgunState {
  status: "locked" | "loading" | "ready" | "unavailable";
  error?: string;
  address?: string;
  balances?: PrivateBalances;
  syncing: boolean;
  syncedAt?: number;
}

export class RailgunUnavailable extends Error {}

let state: RailgunState = { status: "locked", syncing: false };
const listeners = new Set<() => void>();
function set(p: Partial<RailgunState>): void {
  state = { ...state, ...p };
  listeners.forEach((f) => f());
}
export const railgunStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: (): RailgunState => state,
};

/** Railgun storage on top of the encrypted vault, namespaced per wallet so two passkeys never mix notes. */
function vaultStorage(ns: string): RailgunStorage {
  return {
    get: (key) => vaultGet<string>(`railgun:${ns}:${key}`),
    set: (key, value) => vaultSet(`railgun:${ns}:${key}`, value),
  };
}

let client: { wallet: UnlockedWallet; p: Promise<RailgunClient> } | null = null;

async function init(wallet: UnlockedWallet): Promise<RailgunClient> {
  let mod: { initRailgun?: unknown };
  try {
    mod = (await import("@cpay/railgun")) as unknown as { initRailgun?: unknown };
  } catch (e) {
    throw new RailgunUnavailable(`Railgun module failed to load (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof mod.initRailgun !== "function") throw new RailgunUnavailable("this build has no Railgun client");
  const initRailgun = mod.initRailgun as (cfg: RailgunConfig) => Promise<RailgunClient>;
  const cfg = chain();
  return initRailgun({
    seed: railgunSeedOf(wallet),
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl,
    usdc: (cfg.usdc || publicConfig.usdcAddress) as `0x${string}`,
    weth: WETH_ADDRESS,
    artifactsBase: "/railgun-artifacts/",
    wasmUrl: "/railgun/kohaku_bg.wasm",
    bundlerUrl: "/api/bundler",
    storage: vaultStorage(wallet.address.toLowerCase()),
  });
}

/** The Railgun client for the unlocked wallet (made once; a failed init is retried on the next call). */
export function getRailgun(wallet: UnlockedWallet): Promise<RailgunClient> {
  if (client?.wallet === wallet && state.status !== "unavailable") return client.p;
  set({ status: "loading", error: undefined, address: undefined, balances: undefined });
  const p = init(wallet).then(
    (c) => {
      if (client?.p === p) set({ status: "ready", address: c.address() });
      return c;
    },
    (e: unknown) => {
      if (client?.p === p) set({ status: "unavailable", error: e instanceof Error ? e.message : String(e) });
      throw e;
    },
  );
  client = { wallet, p };
  return p;
}

let syncing: Promise<PrivateBalances> | null = null;
/** Sync the private balance from chain, then read it. One sync at a time. */
export function refreshPrivate(wallet: UnlockedWallet): Promise<PrivateBalances> {
  syncing ??= (async () => {
    set({ syncing: true });
    try {
      const c = await getRailgun(wallet);
      await c.sync();
      const balances = await c.balances();
      if (client?.wallet === wallet) set({ balances, syncedAt: Date.now() });
      return balances;
    } finally {
      set({ syncing: false });
      syncing = null;
    }
  })();
  return syncing;
}

/** Current balances without a sync (cheap; the background sync keeps them fresh). */
export async function privateBalances(wallet: UnlockedWallet): Promise<PrivateBalances> {
  const balances = await (await getRailgun(wallet)).balances();
  if (client?.wallet === wallet) set({ balances });
  return balances;
}

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined); // the state already carries the error

/** Warm sync after unlock (called once from the app shell). Lock drops the client. */
let watching = false;
export function watchRailgun(): void {
  if (watching) return;
  watching = true;
  onWallet((w) => {
    if (w) quiet(refreshPrivate(w));
    else {
      client = null;
      set({ status: "locked", error: undefined, address: undefined, balances: undefined, syncedAt: undefined });
    }
  });
}

/** Re-sync every `ms` while a screen (the Pay tab) wants fresh balances. Returns the stop function. */
export function syncEvery(getWallet: () => UnlockedWallet | null, ms = 60_000): () => void {
  const t = setInterval(() => {
    const w = getWallet();
    if (w && state.status !== "unavailable") quiet(refreshPrivate(w));
  }, ms);
  return () => clearInterval(t);
}
