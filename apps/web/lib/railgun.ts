"use client";
// Railgun private balance (payer hiding), on this phone. One client per unlocked wallet, made from the wallet's
// Railgun seed (derived from the passkey here; never logged or sent). Its local state (merkle tree, notes) is
// kept in the encrypted on-device vault. The runtime comes from "@cpay/railgun" by dynamic import: if that
// package or its `initRailgun` isn't there, the state is "unavailable" and the UI says so (never a fake balance).
// Sync only when useful: nothing contacts the Railgun indexer or POI node until this wallet has deposited
// (a vault flag set at the first shield) or the user taps "Load private balance".
import { publicConfig } from "./public-config.js";
import type { PrivateBalances, RailgunClient, RailgunConfig, RailgunStorage } from "./railgun-types.js";
import { vaultGet, vaultSet } from "./vault.js";
import { chain, currentWallet, onWallet, railgunSeedOf, type UnlockedWallet } from "./wallet.js";

export type { PrivateBalances, PrivatePayStage, RailgunClient } from "./railgun-types.js";

export const WETH_ADDRESS = (process.env.NEXT_PUBLIC_WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14") as `0x${string}`;
/**
 * WETH kept shielded for the paymaster fee (~0.003 ETH on Sepolia) + the gas drop to one-time addresses.
 * Testnet POI never validates change notes, so each private payment needs a fresh spendable WETH note.
 */
export const WETH_FEE_TOPUP = 6_000_000_000_000_000n; // 0.006 WETH
export const WETH_FEE_LOW = 5_000_000_000_000_000n; // top up below 0.005 spendable WETH

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

const usedKey = (wallet: UnlockedWallet) => `railgun-used:${wallet.address.toLowerCase()}`;
const usedCache = new WeakMap<UnlockedWallet, boolean>();
/** True once this wallet deposited (or the user loaded the private balance): only then do we sync. */
export async function railgunUsed(wallet: UnlockedWallet): Promise<boolean> {
  const c = usedCache.get(wallet);
  if (c !== undefined) return c;
  const v = (await vaultGet<string>(usedKey(wallet))) === "1";
  usedCache.set(wallet, v);
  return v;
}
/** Called before the first shield, or when the user taps "Load private balance". */
export async function markRailgunUsed(wallet: UnlockedWallet): Promise<void> {
  if (usedCache.get(wallet) === true) return;
  await vaultSet(usedKey(wallet), "1");
  usedCache.set(wallet, true);
}

function configOf(wallet: UnlockedWallet): RailgunConfig {
  const cfg = chain();
  return {
    seed: railgunSeedOf(wallet),
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl,
    usdc: (cfg.usdc || publicConfig.usdcAddress) as `0x${string}`,
    weth: WETH_ADDRESS,
    artifactsBase: "/railgun-artifacts/",
    wasmUrl: "/railgun/kohaku_bg.wasm",
    bundlerUrl: "/api/bundler",
    storage: vaultStorage(wallet.address.toLowerCase()),
  };
}

/**
 * Kohaku's sync and Groth16 proving are long synchronous WASM runs (measured in headless Chromium: up to 2.7 s
 * per task, ~24 s of blocked main thread per sync). So the client runs in a dedicated module worker
 * (lib/railgun.worker.ts). The seed goes in once by postMessage (same origin) and lives only in the worker's
 * memory; storage reads/writes come back here to the encrypted vault. Lock terminates the worker.
 * Without Worker support (or if the worker script can't load), it falls back to this thread.
 */
async function init(wallet: UnlockedWallet): Promise<RailgunClient> {
  const cfg = configOf(wallet);
  if (typeof Worker !== "undefined") {
    let worker: Worker | null = null;
    try {
      const { connectRailgun } = await import("@cpay/railgun/worker-client");
      worker = new Worker(new URL("./railgun.worker.ts", import.meta.url), { type: "module", name: "railgun" });
      return await connectRailgun(worker, cfg);
    } catch (e) {
      // Only a worker that failed to start falls back; a real Railgun error (RPC, chain, WASM) is reported as is.
      if (!(e instanceof Error) || e.message !== "railgun: worker failed") throw e;
      worker?.terminate();
    }
  }
  let mod: { initRailgun?: unknown };
  try {
    mod = (await import("@cpay/railgun")) as unknown as { initRailgun?: unknown };
  } catch (e) {
    throw new RailgunUnavailable(`Railgun module failed to load (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof mod.initRailgun !== "function") throw new RailgunUnavailable("this build has no Railgun client");
  return (mod.initRailgun as (cfg: RailgunConfig) => Promise<RailgunClient>)(cfg);
}

/** Stop the client's worker (drops the seed from its memory). */
function drop(c: { p: Promise<RailgunClient> } | null): void {
  void c?.p.then((x) => (x as { close?: () => void }).close?.(), () => undefined);
}

/** The Railgun client for the unlocked wallet (made once; a failed init is retried on the next call). */
export function getRailgun(wallet: UnlockedWallet): Promise<RailgunClient> {
  if (client?.wallet === wallet && state.status !== "unavailable") return client.p;
  drop(client);
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

/**
 * Whether the private balance can pay `amount` USDC (+ `gasDropWei` ETH to a one-time address) right now:
 * POI-valid USDC incl. the unshield fee, POI-valid WETH for the paymaster fee and the gas drop. No sync.
 */
export async function canPayPrivately(
  wallet: UnlockedWallet,
  amount: bigint,
  gasDropWei: bigint,
): Promise<{ ok: boolean; reason?: "usdc" | "weth"; usdcValid: bigint }> {
  // Never deposited: there is nothing private to spend, and we don't wake the indexer to learn that.
  if (!(await railgunUsed(wallet))) return { ok: false, reason: "usdc", usdcValid: 0n };
  const c = await getRailgun(wallet);
  const can = await c.canPay({ amount, gasDropWei });
  const balances = await c.balances();
  if (client?.wallet === wallet) set({ balances });
  return { ok: can.ok, reason: can.ok ? undefined : can.reason, usdcValid: balances.usdc.valid };
}

/** Current balances without a sync (cheap; the background sync keeps them fresh). */
export async function privateBalances(wallet: UnlockedWallet): Promise<PrivateBalances> {
  const balances = await (await getRailgun(wallet)).balances();
  if (client?.wallet === wallet) set({ balances });
  return balances;
}

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined); // the state already carries the error

/** Warm sync after unlock, only for wallets that deposited (called once from the app shell). Lock drops the client. */
let watching = false;
export function watchRailgun(): void {
  if (watching) return;
  watching = true;
  onWallet((w) => {
    // Start a few seconds after unlock so the unlocked screen renders first (the sync itself runs in the worker).
    if (w) setTimeout(() => quiet(railgunUsed(w).then((used) => (used && currentWallet() === w ? refreshPrivate(w) : undefined))), 4_000);
    else {
      drop(client);
      client = null;
      set({ status: "locked", error: undefined, address: undefined, balances: undefined, syncedAt: undefined });
    }
  });
}

/** Re-sync every `ms` while a screen (the Pay tab) wants fresh balances. Returns the stop function. */
export function syncEvery(getWallet: () => UnlockedWallet | null, ms = 60_000): () => void {
  const t = setInterval(() => {
    const w = getWallet();
    if (w && state.status !== "unavailable") quiet(railgunUsed(w).then((used) => (used ? refreshPrivate(w) : undefined)));
  }, ms);
  return () => clearInterval(t);
}
