// Deterministic spend policy for the agent wallet. Pure: no I/O, no env, no clock (callers pass "today").
// The LLM never reaches this code; it only proposes {amount, token}, which arrive here already validated.
//
//   deny            token not allowed, non-positive amount, balance/gas too low or unknown (fail closed)
//   needs_approval  over the per-payment cap or past the daily cap -> single-use World Agent Pass
//   allow           everything else
// The wallet balance is the hard ceiling: an approval never overrides a deny.

export type PolicyDecision = "allow" | "needs_approval" | "deny";

export interface PolicyConfig {
  /** token symbols, upper-case */
  allowedTokens: readonly string[];
  /** per-payment cap, token base units */
  paymentCap: bigint;
  /** daily cap, token base units */
  dailyCap: bigint;
}

export interface PolicyInput {
  amount: bigint;
  /** symbol, e.g. "USDC" */
  token: string;
  spentToday: bigint;
  /** agent wallet token balance; null = could not be read */
  tokenBalance: bigint | null;
  /** agent wallet ETH balance; null = could not be read */
  ethBalance: bigint | null;
  /** ETH sent with the payment so the one-time address can move funds later */
  gasDropWei: bigint;
}

export interface PolicyCheck {
  id: "amount" | "token" | "payment_cap" | "daily_cap" | "token_balance" | "eth_balance";
  ok: boolean;
  /** true when failing this check needs an Agent Pass approval rather than denying */
  approvable: boolean;
  detail: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  checks: PolicyCheck[];
  overPaymentCap: boolean;
  overDailyCap: boolean;
}

export function evaluatePolicy(cfg: PolicyConfig, input: PolicyInput): PolicyResult {
  const token = input.token.toUpperCase();
  const overPaymentCap = input.amount > cfg.paymentCap;
  const overDailyCap = input.spentToday + input.amount > cfg.dailyCap;
  const checks: PolicyCheck[] = [
    { id: "amount", ok: input.amount > 0n, approvable: false, detail: "amount must be positive" },
    {
      id: "token",
      ok: cfg.allowedTokens.map((t) => t.toUpperCase()).includes(token),
      approvable: false,
      detail: `token ${token} must be in the allow-list [${cfg.allowedTokens.join(", ")}]`,
    },
    { id: "payment_cap", ok: !overPaymentCap, approvable: true, detail: `amount <= per-payment cap ${cfg.paymentCap}` },
    {
      id: "daily_cap",
      ok: !overDailyCap,
      approvable: true,
      detail: `spent today ${input.spentToday} + amount <= daily cap ${cfg.dailyCap}`,
    },
    {
      id: "token_balance",
      ok: input.tokenBalance !== null && input.tokenBalance >= input.amount,
      approvable: false,
      detail: input.tokenBalance === null ? "agent wallet token balance unavailable" : `agent wallet holds ${input.tokenBalance}`,
    },
    {
      id: "eth_balance",
      ok: input.ethBalance !== null && input.ethBalance > input.gasDropWei,
      approvable: false,
      detail: input.ethBalance === null ? "agent wallet ETH balance unavailable" : `agent wallet ETH ${input.ethBalance} > gas drop ${input.gasDropWei}`,
    },
  ];
  const failed = checks.filter((c) => !c.ok);
  const decision: PolicyDecision = failed.some((c) => !c.approvable)
    ? "deny"
    : failed.length > 0
      ? "needs_approval"
      : "allow";
  return { decision, checks, overPaymentCap, overDailyCap };
}

// ---- spent-today ledger (pure transitions; the phone keeps the ledger) ----

export interface LedgerPayment {
  sessionId: string;
  token: string;
  /** base units */
  amount: string;
  txHash: string;
  at: string;
}

export interface Ledger {
  v: 1;
  /** local YYYY-MM-DD */
  day: string;
  /** symbol -> base units spent on `day` */
  spent: Record<string, string>;
  /** every payment the agent made (sessionIds are never paid twice) */
  payments: LedgerPayment[];
}

export const emptyLedger = (day: string): Ledger => ({ v: 1, day, spent: {}, payments: [] });

/** Local calendar day of the payer laptop. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function spentToday(ledger: Ledger, token: string, today: string): bigint {
  if (ledger.day !== today) return 0n;
  return BigInt(ledger.spent[token.toUpperCase()] ?? "0");
}

export function hasPaidSession(ledger: Ledger, sessionId: string): boolean {
  return ledger.payments.some((p) => p.sessionId === sessionId);
}

export function recordSpend(ledger: Ledger, payment: LedgerPayment, today: string): Ledger {
  const token = payment.token.toUpperCase();
  const spent = ledger.day === today ? { ...ledger.spent } : {};
  spent[token] = (BigInt(spent[token] ?? "0") + BigInt(payment.amount)).toString();
  return { v: 1, day: today, spent, payments: [...ledger.payments, { ...payment, token }] };
}
