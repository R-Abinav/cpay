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
  | { kind: "cpay"; peerId: string; pub: string; qrSecret: string }
  | { kind: "offline"; metaAddress: string }
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

/**
 * The BBS holder secret s + commitment blinding, derived from the passkey on this phone
 * (cpay/v1/bbs-holder, cpay/v1/bbs-blinding). Null while the wallet is locked. Never leaves the device.
 */
export function bbsSeed(): { s: Uint8Array; blinding: Uint8Array } | null {
  const k = (w.currentWallet() as { keys?: { bbsHolder: Uint8Array; bbsBlinding: Uint8Array } } | null)?.keys;
  return k ? { s: k.bbsHolder, blinding: k.bbsBlinding } : null;
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
    | { kind: "cpay"; peerId: string; pub: string; qrSecret: string }
    | { kind: "offline"; metaAddress: string }
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
  // Only a plain address, a verified one-time address, or an offline-QR one-time address derived on this phone can
  // reach policy. An unverified CPay/face peer can't. Plain + offline are "not verified": same caps, over a cap ->
  // Agent Pass.
  const rc = args.recipient;
  const to = rc.kind === "address" ? rc.address : rc.kind === "private" || rc.kind === "offline" ? rc.destination : null;
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

// ---------------------------------------------------------------- offline CPay QR (cpay:2, opt-in)

export type OfflineDestination = { address: `0x${string}`; ephemeralPublicKey: string; viewTag: string };

/** Payer: a fresh one-time address for a scanned offline QR's meta-address (derived on this phone). */
export function deriveOfflineDestination(metaAddress: string): OfflineDestination {
  return fn<(m: string) => OfflineDestination>("deriveOfflineDestination")(metaAddress);
}

/** Payer: ERC-5564 announcement, then USDC + gas drop to the derived address. Signed on this phone. */
export async function payOffline(
  x: UnlockedWallet,
  p: { destination: string; ephemeralPublicKey: string; viewTag: string; amount: string },
): Promise<{ announceHash: string; transferHash: string; gasDropHash: string | null }> {
  const amount = toBaseUnits(p.amount);
  if (amount === null) throw new Error("invalid amount");
  return (await fn<(a: unknown) => Promise<{ announceHash: string; transferHash: string; gasDropHash: string | null }>>("payOffline")({
    account: handle(x).account,
    destination: { address: p.destination, ephemeralPublicKey: p.ephemeralPublicKey, viewTag: p.viewTag },
    amount,
    token: chain().usdc,
    cfg: chain(),
  })) as { announceHash: string; transferHash: string; gasDropHash: string | null };
}

/** Recipient: the offline QR text (`CPAY:2:<meta-address>`): a STABLE identifier, shown only when opted in. */
export function offlineQr(x: UnlockedWallet): string {
  const keys = fn<(k: unknown) => { metaAddressURI: string }>("deriveStealthKeys")(handle(x).keys);
  return fn<(m: string) => string>("offlineQrText")(keys.metaAddressURI);
}

export async function offlineReceiveEnabled(): Promise<boolean> {
  return ((await fn<() => Promise<{ enabled: boolean }>>("offlineReceiveState")()) as { enabled: boolean }).enabled;
}

/** Turn "receive while offline" on/off (the first enable reads the current block from the RPC as the scan start). */
export async function setOfflineReceive(enabled: boolean): Promise<void> {
  await fn<(e: boolean, o: unknown) => Promise<unknown>>("setOfflineReceive")(enabled, { cfg: chain() });
}

/** Recipient: scan ERC-5564 announcements with the viewing key ON THIS PHONE; returns how many new payments were found. */
export async function scanOfflinePayments(x: UnlockedWallet): Promise<number> {
  const r = (await fn<(a: unknown) => Promise<{ found: unknown[] }>>("scanOfflinePayments")({
    stealthKeys: stealthKeysOf(x),
    cfg: chain(),
  })) as { found: unknown[] };
  return r.found.length;
}

/** BBS proof for recipient.hello, bound to the relay's challenge + our X25519 pub (made on this phone). */
export async function relayHelloProof(args: { card: unknown; issuerPublicKey: string; nonce: string; pub: string }): Promise<string> {
  return fn<(a: unknown) => Promise<string>>("relayHelloProof")(args);
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
  ethRaw: bigint;
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
  return rows.map((r) => ({
    address: r.address,
    createdAt: r.createdAt,
    usdc: fmtUnits(r.balance, 6),
    eth: fmtUnits(r.eth, 18),
    usdcRaw: r.balance,
    ethRaw: r.eth,
  }));
}

/**
 * Move one one-time address's USDC (then its leftover gas-drop ETH) to the agent wallet. Links the two
 * on-chain (the UI warns first). `ethHash` is null when only dust was left or the ETH leg failed.
 */
export async function sweepToAgent(x: UnlockedWallet, destination: `0x${string}`): Promise<{ hash: string; amount: string; ethHash: string | null }> {
  const r = (await fn<(a: unknown) => Promise<{ hash: string; amount: bigint; eth?: { hash: string } | null }>>("sweepOneTime")({
    stealthKeys: stealthKeysOf(x),
    destination,
    to: x.address,
    cfg: chain(),
  })) as { hash: string; amount: bigint; eth?: { hash: string } | null };
  return { hash: r.hash, amount: fmtUnits(r.amount, 6), ethHash: r.eth?.hash ?? null };
}

/**
 * How many one-time addresses a private send of `amount` USDC would use (fewest possible), from balances the
 * user already loaded. Null if they can't cover it. Local only; the real plan is re-made at send time.
 */
export function privateSendLegs(rows: OneTimeBalance[], amount: string): number | null {
  const base = toBaseUnits(amount);
  if (base === null || base <= 0n) return null;
  const plan = fn<(s: unknown, a: bigint, g: bigint) => unknown[] | null>("planPrivateSend")(
    rows.map((r) => ({ address: r.address, balance: r.usdcRaw, eth: r.ethRaw })),
    base,
    1n,
  );
  return plan ? plan.length : null;
}

export interface PrivateSendLegView {
  from: `0x${string}`;
  amount: string;
  hash: string;
}

/**
 * Pay `to` from the private balance: each one-time address signs its own USDC transfer on this phone (gas
 * from its gas drop). The agent wallet signs nothing. On a partial failure the error carries `done` legs.
 */
export async function sendPrivately(x: UnlockedWallet, p: { to: string; amount: string }): Promise<PrivateSendLegView[]> {
  const amount = toBaseUnits(p.amount);
  if (amount === null || amount <= 0n) throw new Error("invalid amount");
  const view = (legs: { from: `0x${string}`; amount: bigint; hash: string }[]) => legs.map((l) => ({ from: l.from, amount: fmtUnits(l.amount, 6), hash: l.hash }));
  try {
    const r = (await fn<(a: unknown) => Promise<{ legs: { from: `0x${string}`; amount: bigint; hash: string }[] }>>("sendFromPrivate")({
      stealthKeys: stealthKeysOf(x),
      to: p.to,
      amount,
      token: chain().usdc,
      cfg: chain(),
    })) as { legs: { from: `0x${string}`; amount: bigint; hash: string }[] };
    return view(r.legs);
  } catch (e) {
    const done = (e as { done?: { from: `0x${string}`; amount: bigint; hash: string }[] }).done;
    if (done?.length) throw new PartialSendError(e instanceof Error ? e.message : String(e), view(done));
    throw e;
  }
}

export class PartialSendError extends Error {
  constructor(
    message: string,
    readonly done: PrivateSendLegView[],
  ) {
    super(message);
  }
}

/**
 * The Agent Pass binding for one payment: {sessionId, amount in base units, token contract, to}.
 * Throws for anything the wallet couldn't pay (bad amount, unsupported token).
 */
export function approvalBinding(p: { sessionId: string; amount: string; token: string; to: string }): ApprovalBindingJson {
  if (p.token !== "USDC") throw new Error("Agent Pass: unsupported token");
  const base = w.toBaseUnits(p.amount) as bigint | null;
  if (base === null) throw new Error("Agent Pass: invalid amount");
  return { sessionId: p.sessionId, amount: base.toString(), token: chain().usdc, to: p.to };
}
export type ApprovalBindingJson = { sessionId: string; amount: string; token: string; to: string };

/**
 * A fresh 32-byte salt + the salted commitment to this binding. Only `bindingCommit` goes to the
 * Agent Pass server; the binding and the salt stay on this phone for verifyApproval().
 */
export function approvalCommit(binding: ApprovalBindingJson): { salt: Uint8Array; bindingCommit: string } {
  const salt = w.newApprovalSalt() as Uint8Array;
  return { salt, bindingCommit: w.approvalBindingCommit(binding, salt) as string };
}

/**
 * Check a World Agent Pass approval token on this phone before signing: our Ed25519 signature
 * (NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY), the commitment recomputed from exactly this binding + salt,
 * the World account linked on this phone, not expired, jti never used here before (then marked used).
 * Returns null if OK, else the reason.
 */
export async function verifyApproval(token: string, expected: ApprovalBindingJson, salt: Uint8Array, subHash: string): Promise<string | null> {
  const r = (await w.verifyApprovalToken(token, {
    expected,
    salt,
    subHash,
    publicKey: process.env.NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY || undefined,
  })) as { ok: true } | { ok: false; reason: string };
  return r.ok ? null : r.reason;
}

export function newConfirmCode(): number {
  return Number(w.newConfirmCode());
}
export function matchConfirm(transcript: string, code: number): ConfirmMatch {
  return w.matchConfirm(transcript, code) as ConfirmMatch;
}
