// Deterministic spend policy, on the phone. The AI proposes {amount, token}; this decides.
import { fromBaseUnits, toBaseUnits, TOKENS, type Token } from "./amount.js";
import { kvGet, kvSet } from "./storage.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export interface PolicySettings {
  paymentCapUsdc: string;
  dailyCapUsdc: string;
  allowedTokens: Token[];
}

export type PolicyResult =
  | { decision: "allow" }
  | { decision: "needs_approval"; reason: "over_payment_cap" | "over_daily_cap" }
  | {
      decision: "deny";
      reason: "token_not_allowed" | "insufficient_balance" | "unknown_balance" | "invalid_amount" | "qr_amount_mismatch";
    };

/**
 * Order of checks: amount format -> token allow-list -> QR amount match -> balance (unknown or too
 * low = deny) -> per-payment cap -> daily cap. Any deny wins over needs_approval: an Agent Pass
 * approval can lift a cap, never a missing balance or a mismatched QR.
 */
export function evaluate(
  i: { amount: string; token: Token },
  r: { to: `0x${string}`; qrAmount?: string },
  s: PolicySettings,
  spentTodayUsdc: string,
  balance: { usdc: bigint } | null,
): PolicyResult {
  const amount = toBaseUnits(i.amount);
  if (amount === null) return { decision: "deny", reason: "invalid_amount" };
  if (!s.allowedTokens.includes(i.token) || !TOKENS.includes(i.token)) return { decision: "deny", reason: "token_not_allowed" };
  if (r.qrAmount !== undefined && toBaseUnits(r.qrAmount) !== amount) return { decision: "deny", reason: "qr_amount_mismatch" };
  if (balance === null || typeof balance.usdc !== "bigint") return { decision: "deny", reason: "unknown_balance" };
  if (balance.usdc < amount) return { decision: "deny", reason: "insufficient_balance" };

  const cap = toBaseUnits(s.paymentCapUsdc, { allowZero: true });
  const daily = toBaseUnits(s.dailyCapUsdc, { allowZero: true });
  // Malformed caps or ledger fail closed: ask for approval rather than allow.
  const spent = toBaseUnits(spentTodayUsdc, { allowZero: true });
  if (cap === null || amount > cap) return { decision: "needs_approval", reason: "over_payment_cap" };
  if (daily === null || spent === null || spent + amount > daily) return { decision: "needs_approval", reason: "over_daily_cap" };
  return { decision: "allow" };
}

function envDefaults(): { cap?: string; daily?: string; tokens?: string } {
  try {
    return {
      cap: process.env.NEXT_PUBLIC_DEFAULT_PAYMENT_CAP_USDC,
      daily: process.env.NEXT_PUBLIC_DEFAULT_DAILY_CAP_USDC,
      tokens: process.env.NEXT_PUBLIC_ALLOWED_TOKENS,
    };
  } catch {
    return {};
  }
}

export function defaultSettings(): PolicySettings {
  const e = envDefaults();
  const cap = e.cap && toBaseUnits(e.cap, { allowZero: true }) !== null ? e.cap : "5";
  const daily = e.daily && toBaseUnits(e.daily, { allowZero: true }) !== null ? e.daily : "15";
  const listed = (e.tokens || "USDC")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t): t is Token => (TOKENS as readonly string[]).includes(t));
  return { paymentCapUsdc: cap, dailyCapUsdc: daily, allowedTokens: listed.length ? [...new Set(listed)] : ["USDC"] };
}

function validSettings(s: unknown): s is PolicySettings {
  const x = s as PolicySettings;
  return (
    !!x &&
    toBaseUnits(x.paymentCapUsdc, { allowZero: true }) !== null &&
    toBaseUnits(x.dailyCapUsdc, { allowZero: true }) !== null &&
    Array.isArray(x.allowedTokens) &&
    x.allowedTokens.every((t) => (TOKENS as readonly string[]).includes(t))
  );
}

/**
 * True if going from `prev` to `next` loosens the policy (a higher cap or a new token). The UI must
 * get an Agent Pass approval before saving such a change.
 */
export function settingsRaise(prev: PolicySettings, next: PolicySettings): boolean {
  const gt = (a: string, b: string) => (toBaseUnits(a, { allowZero: true }) ?? 0n) > (toBaseUnits(b, { allowZero: true }) ?? 0n);
  return (
    gt(next.paymentCapUsdc, prev.paymentCapUsdc) ||
    gt(next.dailyCapUsdc, prev.dailyCapUsdc) ||
    next.allowedTokens.some((t) => !prev.allowedTokens.includes(t))
  );
}

const K_SETTINGS = "policy.settings";
const K_LEDGER = "policy.ledger";

export async function loadSettings(): Promise<PolicySettings> {
  const s = await kvGet<PolicySettings>(K_SETTINGS);
  return validSettings(s) ? { ...s, allowedTokens: [...s.allowedTokens] } : defaultSettings();
}

export async function saveSettings(s: PolicySettings): Promise<void> {
  if (!validSettings(s)) throw new Error("wallet: invalid policy settings");
  await kvSet(K_SETTINGS, { paymentCapUsdc: s.paymentCapUsdc, dailyCapUsdc: s.dailyCapUsdc, allowedTokens: [...new Set(s.allowedTokens)] });
}

// ---- spent-today ledger (per device, local calendar day) ----
// Stores only today's total and sha256 of today's tx hashes (to make recordSpend idempotent).
// No history, no recipients.

interface Ledger {
  day: string;
  totalBase: string;
  txs: string[];
}

function today(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

async function loadLedger(now?: Date): Promise<Ledger> {
  const l = await kvGet<Ledger>(K_LEDGER);
  const d = today(now);
  if (!l || l.day !== d || !/^[0-9]+$/.test(l.totalBase)) return { day: d, totalBase: "0", txs: [] };
  return l;
}

/** Total paid today on this device, as a decimal USDC string. */
export async function spentToday(now?: Date): Promise<string> {
  return fromBaseUnits(BigInt((await loadLedger(now)).totalBase));
}

/** Add a confirmed payment to today's total. Recording the same txHash twice counts once. */
export async function recordSpend(amount: string, txHash: string, now?: Date): Promise<void> {
  const v = toBaseUnits(amount);
  if (v === null) throw new Error("wallet: invalid amount");
  const l = await loadLedger(now);
  const h = bytesToHex(sha256(utf8ToBytes(txHash.toLowerCase())));
  if (l.txs.includes(h)) return;
  await kvSet(K_LEDGER, { day: l.day, totalBase: (BigInt(l.totalBase) + v).toString(), txs: [...l.txs, h] });
}
