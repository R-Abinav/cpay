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
  // Only a plain address or a verified one-time address can reach policy. An unverified CPay/face peer can't.
  const to = args.recipient.kind === "address" ? args.recipient.address : args.recipient.kind === "private" ? args.recipient.destination : null;
  const qrAmount = args.recipient.kind === "address" ? args.recipient.amount : undefined;
  if (!to) return { decision: "deny", reason: "unverified_recipient" };
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
    { to, qrAmount },
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

// ---------------------------------------------------------------- private (one-time) payments: pay protocol v2
// Coded against @cpay/wallet (payments-face, Fri 6 Nov):
//   deriveStealthKeys(WalletKeys) -> StealthKeys; newOneTimeDestination / listOneTimeDestinations (persisted on device)
//   oneTimeBalances(publicClient, token) -> (StoredDestination & {balance, eth})[]
//   sweepOneTime({stealthKeys, destination, to, cfg?, token?}) -> {hash, amount}
//   payOneTime({account, destination, amount, token?, gasDropWei?, cfg?}) -> {transferHash, gasDropHash|null}
//   answerQuote({quote, card, issuerPublicKey, stealthKeys}) -> Claim2Body
//   verifyClaim2({round, claim, issuerPublicKey}) -> {ok:true, destination, tier, epoch} | {ok:false, reason}
// If the installed @cpay/wallet doesn't export one yet, callers get NotConnectedError (shown as "not connected").

export class NotConnectedError extends Error {}
function fn<T extends (...a: any[]) => any>(name: string): T {
  const f = w[name];
  if (typeof f !== "function") throw new NotConnectedError(`@cpay/wallet.${name} is not available in this build`);
  return f as T;
}
function handle(x: UnlockedWallet): { account: unknown; keys: unknown } {
  const h = x as unknown as { account?: unknown; keys?: unknown };
  if (!h.account || !h.keys) throw new Error("Wallet locked");
  return { account: h.account, keys: h.keys };
}

/** Opaque stealth keys (derived on this phone from the unlocked wallet; never stored by the web app). */
export type StealthKeysRef = { readonly __stealth: unique symbol };
export function stealthKeysOf(x: UnlockedWallet): StealthKeysRef {
  return fn<(k: unknown) => StealthKeysRef>("deriveStealthKeys")(handle(x).keys);
}

/** Decimal USDC -> base units (strict; null when invalid). */
export function toBaseUnits(amount: string): bigint | null {
  return w.toBaseUnits(amount) as bigint | null;
}

export type Claim2Verdict = { ok: true; destination: `0x${string}`; tier: string; epoch: string } | { ok: false; reason: string };
export async function verifyClaim2(args: { round: unknown; claim: unknown; issuerPublicKey: string }): Promise<Claim2Verdict> {
  return (await fn<(a: unknown) => Promise<Claim2Verdict>>("verifyClaim2")(args)) as Claim2Verdict;
}

export async function answerQuote(args: { quote: unknown; card: unknown; issuerPublicKey: string; stealthKeys: StealthKeysRef }): Promise<unknown> {
  return fn<(a: unknown) => Promise<unknown>>("answerQuote")(args);
}

/** USDC (+ gas drop) to a verified one-time address. Signed on this phone. Resolves after the transfer receipt. */
export async function payOneTime(x: UnlockedWallet, p: { destination: string; amount: string }): Promise<{ transferHash: string; gasDropHash: string | null }> {
  const amount = toBaseUnits(p.amount);
  if (amount === null) throw new Error("invalid amount");
  const r = (await fn<(a: unknown) => Promise<{ transferHash: string; gasDropHash: string | null }>>("payOneTime")({
    account: handle(x).account,
    destination: p.destination,
    amount,
    token: chain().usdc,
    cfg: chain(),
  })) as { transferHash: string; gasDropHash: string | null };
  return r;
}

export interface OneTimeBalance {
  address: `0x${string}`;
  createdAt: number;
  usdc: string;
  eth: string;
  usdcRaw: bigint;
}

/** Number of one-time addresses this phone has handed out (local only, no network). */
export async function oneTimeCount(): Promise<number> {
  const list = (await fn<() => Promise<unknown[]>>("listOneTimeDestinations")()) as unknown[];
  return list.length;
}

/** Reads every one-time address's balance from the RPC in one go (the RPC can link them): only on user request. */
export async function oneTimeBalances(): Promise<OneTimeBalance[]> {
  const { createPublicClient, http } = await import("viem");
  const cfg = chain();
  const client = createPublicClient({ chain: w.chainOf(cfg), transport: http(cfg.rpcUrl, { timeout: 15_000 }) });
  const rows = (await fn<(c: unknown, t: string) => Promise<{ address: `0x${string}`; createdAt: number; balance: bigint; eth: bigint }[]>>(
    "oneTimeBalances",
  )(client, cfg.usdc)) as { address: `0x${string}`; createdAt: number; balance: bigint; eth: bigint }[];
  return rows.map((r) => ({ address: r.address, createdAt: r.createdAt, usdc: fmtUnits(r.balance, 6), eth: fmtUnits(r.eth, 18), usdcRaw: r.balance }));
}

/** Sweep one one-time address's USDC to the agent wallet. Links the two on-chain (the UI warns first). */
export async function sweepToAgent(x: UnlockedWallet, destination: `0x${string}`): Promise<{ hash: string; amount: string }> {
  const r = (await fn<(a: unknown) => Promise<{ hash: string; amount: bigint }>>("sweepOneTime")({
    stealthKeys: stealthKeysOf(x),
    destination,
    to: x.address,
    cfg: chain(),
  })) as { hash: string; amount: bigint };
  return { hash: r.hash, amount: fmtUnits(r.amount, 6) };
}

export function newConfirmCode(): number {
  return Number(w.newConfirmCode());
}
export function matchConfirm(transcript: string, code: number): ConfirmMatch {
  return w.matchConfirm(transcript, code) as ConfirmMatch;
}
