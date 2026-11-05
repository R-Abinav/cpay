"use client";
// THE ONLY FILE THAT IMPORTS @cpay/wallet. Everything in apps/web uses the typed facade below, so if the
// package's real shapes differ from what we coded against, the fix (and any type error) lives here only.
//
// Coded against (from the lead's brief): hasWallet, createWallet({rpId}), unlock({rpId}), prfSupported,
// chainFromEnv, balances, payDirect(cfg, w, {to, amount, token}), parseQr(text, cfg), evaluate(...),
// defaultSettings/loadSettings/saveSettings, spentToday/recordSpend, newConfirmCode, matchConfirm.
// Keys and signing stay inside @cpay/wallet, on this phone. Nothing here talks to a server.
import * as W from "@cpay/wallet";
import type { ConfirmMatch, Decision, Recipient } from "./pay-machine.js";

/** The unlocked agent wallet. Only `address` is read by the UI; the rest is passed back to @cpay/wallet. */
export interface UnlockedWallet {
  address: `0x${string}`;
}
/** Opaque chain config from chainFromEnv(). */
export type ChainConfig = { readonly chainId: number } & Record<string, unknown>;
/** Policy settings. Edited generically in Settings (numeric/string fields only). */
export type WalletSettings = Record<string, unknown>;

export type ParsedQr =
  | { kind: "address"; address: string; chainId?: number; token?: string; amount?: string }
  | { kind: "cpay"; peerId: string; pub: string }
  | { kind: "unsupported"; reason?: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = W as any;

export const rpId = (): string => process.env.NEXT_PUBLIC_PASSKEY_RP_ID || (typeof location !== "undefined" ? location.hostname : "");
export const explorerUrl = (): string => (process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://sepolia.basescan.org").replace(/\/$/, "");
export const txUrl = (hash: string) => `${explorerUrl()}/tx/${hash}`;
export const addressUrl = (a: string) => `${explorerUrl()}/address/${a}`;

let cfg: ChainConfig | null = null;
export function chain(): ChainConfig {
  cfg ??= w.chainFromEnv() as ChainConfig;
  return cfg;
}

export async function hasWallet(): Promise<boolean> {
  return Boolean(await w.hasWallet());
}
export async function prfSupported(): Promise<boolean> {
  return Boolean(await w.prfSupported());
}

// The unlocked wallet lives in memory for this tab only; reloading asks for the passkey again.
let unlocked: UnlockedWallet | null = null;
const unlockL = new Set<(w: UnlockedWallet | null) => void>();
export function currentWallet(): UnlockedWallet | null {
  return unlocked;
}
export function onWallet(fn: (w: UnlockedWallet | null) => void): () => void {
  unlockL.add(fn);
  fn(unlocked);
  return () => unlockL.delete(fn);
}
function setUnlocked(x: UnlockedWallet | null) {
  unlocked = x;
  unlockL.forEach((f) => f(x));
}

export async function createWallet(): Promise<UnlockedWallet> {
  const x = (await w.createWallet({ rpId: rpId() })) as UnlockedWallet;
  setUnlocked(x);
  return x;
}
export async function unlockWallet(): Promise<UnlockedWallet> {
  const x = (await w.unlock({ rpId: rpId() })) as UnlockedWallet;
  setUnlocked(x);
  return x;
}
export function lockWallet(): void {
  setUnlocked(null);
}

const fmt = (v: unknown, decimals: number): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") {
    const s = v.toString().padStart(decimals + 1, "0");
    const f = s.slice(-decimals).replace(/0+$/, "");
    return f ? `${s.slice(0, -decimals)}.${f}` : s.slice(0, -decimals);
  }
  return "?";
};
/** Formatted balances ("1.5"). */
export async function getBalances(address: string): Promise<{ eth: string; usdc: string }> {
  const b = (await w.balances(chain(), address)) as { eth: unknown; usdc: unknown };
  return { eth: fmt(b.eth, 18), usdc: fmt(b.usdc, 6) };
}

export function parseQr(text: string): ParsedQr {
  return w.parseQr(text, chain()) as ParsedQr;
}

/** Map a parse failure to the OLED screen to show. */
export function unsupportedWhy(p: ParsedQr): "not_wallet" | "wrong_network" {
  const r = p.kind === "unsupported" ? String(p.reason ?? "") : "";
  return /network|chain/i.test(r) ? "wrong_network" : "not_wallet";
}

export async function evaluatePolicy(args: {
  amount: string;
  token: string;
  recipient: Recipient;
  balanceUsdc: string | null;
}): Promise<{ decision: Decision; reason?: string }> {
  const settings = await loadSettings();
  const ledger = await spentToday();
  const r = await w.evaluate({ amount: args.amount, token: args.token }, args.recipient, settings, ledger, args.balanceUsdc);
  return { decision: r.decision as Decision, reason: r.reason ?? r.detail };
}

export async function payDirect(wallet: UnlockedWallet, p: { to: string; amount: string; token: string }): Promise<string> {
  const r = await w.payDirect(chain(), wallet, p);
  return typeof r === "string" ? r : (r.hash ?? r.txHash);
}

export function defaultSettings(): WalletSettings {
  return w.defaultSettings() as WalletSettings;
}
export async function loadSettings(): Promise<WalletSettings> {
  return ((await w.loadSettings()) ?? defaultSettings()) as WalletSettings;
}
export async function saveSettings(s: WalletSettings): Promise<void> {
  await w.saveSettings(s);
}
export async function spentToday(): Promise<unknown> {
  return w.spentToday();
}
export async function recordSpend(amount: string, token: string): Promise<void> {
  await w.recordSpend(amount, token);
}

export function newConfirmCode(): number {
  return Number(w.newConfirmCode());
}
export function matchConfirm(transcript: string, code: number): ConfirmMatch {
  return w.matchConfirm(transcript, code) as ConfirmMatch;
}
