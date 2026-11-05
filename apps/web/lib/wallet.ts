"use client";
// THE ONLY FILE THAT IMPORTS @cpay/wallet. Everything in apps/web uses the facade below, so if the
// package's shapes change, the fix lives here only. Keys and signing stay inside @cpay/wallet, on this
// phone. Nothing here talks to our servers.
//
// Coded against @cpay/wallet src/index.ts as of Fri 6 Nov (payments worktree):
//   hasWallet(), prfSupported(), createWallet({rpId}), unlock({rpId}), lock() -> WalletHandle{address, account, ...}
//   chainFromEnv() -> ChainConfig{chainId, rpcUrl, usdc, explorerUrl}; balances(cfg, addr) -> {eth: bigint, usdc: bigint}
//   parseQr(text, cfg) -> {kind:"cpay", peerId, pub} | {kind:"address", to, amount?, token?, chainId?}
//                         | {kind:"unsupported", reason:"not_wallet"|"wrong_chain"|"bad_address"|"unsupported_token"}
//   evaluate({amount, token}, {to, qrAmount?}, settings, spentTodayUsdc: string, {usdc: bigint} | null) -> PolicyResult
//   payDirect(cfg, handle, {to, amount, token}) -> {txHash, explorerUrl}; recordSpend(amount, txHash); spentToday() -> string
//   loadSettings/saveSettings/defaultSettings/settingsRaise(prev, next); newConfirmCode(); matchConfirm(text, code)
import * as W from "@cpay/wallet";
import type { ConfirmMatch, Decision, Recipient } from "./pay-machine.js";

/** The unlocked agent wallet handle. The UI reads only `address`; the handle goes back to @cpay/wallet to sign. */
export interface UnlockedWallet {
  address: `0x${string}`;
}
export type ChainConfig = { chainId: number; rpcUrl: string; usdc: `0x${string}`; explorerUrl: string };
/** PolicySettings {paymentCapUsdc, dailyCapUsdc, allowedTokens}. Edited generically in Settings (string fields). */
export type WalletSettings = Record<string, unknown>;

export type ParsedQr =
  | { kind: "address"; address: string; chainId?: number; token?: string; amount?: string }
  | { kind: "cpay"; peerId: string; pub: string }
  | { kind: "unsupported"; reason?: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = W as any;

export const rpId = (): string => process.env.NEXT_PUBLIC_PASSKEY_RP_ID || (typeof location !== "undefined" ? location.hostname : "");

let cfg: ChainConfig | null = null;
export function chain(): ChainConfig {
  cfg ??= w.chainFromEnv() as ChainConfig;
  return cfg;
}
const explorer = () => (process.env.NEXT_PUBLIC_EXPLORER_URL || "https://sepolia.basescan.org").replace(/\/+$/, "");
export const txUrl = (hash: string) => `${explorer()}/tx/${hash}`;
export const addressUrl = (a: string) => `${explorer()}/address/${a}`;

export async function hasWallet(): Promise<boolean> {
  return Boolean(await w.hasWallet());
}
export async function prfSupported(): Promise<boolean> {
  return Boolean(await w.prfSupported());
}

// The unlocked handle lives in memory for this tab only; a reload asks for the passkey again.
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
  w.lock();
  setUnlocked(null);
}

function fmtUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const f = s.slice(-decimals).replace(/0+$/, "");
  return f ? `${s.slice(0, -decimals)}.${f}` : s.slice(0, -decimals);
}

async function rawBalances(address: string): Promise<{ eth: bigint; usdc: bigint }> {
  return (await w.balances(chain(), address)) as { eth: bigint; usdc: bigint };
}
/** Formatted balances ("1.5"). */
export async function getBalances(address: string): Promise<{ eth: string; usdc: string }> {
  const b = await rawBalances(address);
  return { eth: fmtUnits(b.eth, 18), usdc: fmtUnits(b.usdc, 6) };
}

export function parseQr(text: string): ParsedQr {
  const r = w.parseQr(text, chain()) as
    | { kind: "address"; to: string; amount?: string; token?: string; chainId?: number }
    | { kind: "cpay"; peerId: string; pub: string }
    | { kind: "unsupported"; reason: string };
  if (r.kind === "address") return { kind: "address", address: r.to, amount: r.amount, token: r.token, chainId: r.chainId };
  return r;
}

/** Map a parse failure to the OLED screen to show. */
export function unsupportedWhy(p: ParsedQr): "not_wallet" | "wrong_network" {
  const r = p.kind === "unsupported" ? String(p.reason ?? "") : "";
  return /network|chain/i.test(r) ? "wrong_network" : "not_wallet";
}

/** Policy on the phone. Unknown balance -> the wallet denies (fail closed). */
export async function evaluatePolicy(args: {
  wallet: UnlockedWallet;
  amount: string;
  token: string;
  recipient: Recipient;
}): Promise<{ decision: Decision; reason?: string }> {
  if (args.recipient.kind !== "address") return { decision: "deny", reason: "cpay_not_wired" };
  const settings = await w.loadSettings();
  const spent = (await w.spentToday()) as string;
  let balance: { usdc: bigint } | null = null;
  try {
    balance = await rawBalances(args.wallet.address);
  } catch {
    balance = null;
  }
  const r = w.evaluate(
    { amount: args.amount, token: args.token },
    { to: args.recipient.address, qrAmount: args.recipient.amount },
    settings,
    spent,
    balance,
  ) as { decision: Decision; reason?: string };
  return { decision: r.decision, reason: r.reason };
}

/** Sign on this phone and send. Resolves after the receipt (throws on revert). */
export async function payDirect(wallet: UnlockedWallet, p: { to: string; amount: string; token: string }): Promise<string> {
  const r = (await w.payDirect(chain(), wallet, p)) as { txHash: string };
  return r.txHash;
}
export async function recordSpend(amount: string, txHash: string): Promise<void> {
  await w.recordSpend(amount, txHash);
}

export async function loadSettings(): Promise<WalletSettings> {
  return (await w.loadSettings()) as WalletSettings;
}
/** Raising a cap needs World Agent Pass (not wired in the PWA yet), so raises are refused here. */
export async function saveSettings(next: WalletSettings): Promise<void> {
  const prev = await w.loadSettings();
  if (w.settingsRaise(prev, next)) throw new Error("Raising a limit needs World Agent Pass, which isn't connected yet. Lowering works.");
  await w.saveSettings(next);
}

export function newConfirmCode(): number {
  return Number(w.newConfirmCode());
}
export function matchConfirm(transcript: string, code: number): ConfirmMatch {
  return w.matchConfirm(transcript, code) as ConfirmMatch;
}
