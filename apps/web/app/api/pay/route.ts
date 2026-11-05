// /api/pay: the ONLY signer. It re-checks everything server-side and never trusts the browser:
//   1. zod-validate the body
//   2. verify the BBS proof against the issuer key + the recomputed bindingDigest
//   3. policy: allow-list, per-payment cap, daily cap (ledger), agent wallet balance (hard ceiling)
//   4. physical confirm event for exactly this session, recent
//   5. over a cap -> consume the single-use Agent Pass approval for exactly {sessionId, amount, token}
//   6. payToDestination with the agent wallet (USDC + gas drop)
//   7. update the spent-today ledger
// GET /api/pay?amount=<base units>&token=<symbol> is a read-only policy preview (no signing).
import { bindingDigest } from "@cpay/protocol";
import { initCredential, verifyProof } from "@cpay/credential";
import { consumeApproval } from "@cpay/world";
import { payToDestination } from "@cpay/stealth";
import { getAddress, http, isAddressEqual, type Address } from "viem";
import { PayRequest, type PolicyJson, type WalletJson } from "../../../lib/api.js";
import { dayKey, evaluatePolicy, hasPaidSession, recordSpend, spentToday, type PolicyResult } from "../../../lib/policy.js";
import { chainConfig, issuerPublicKey, policyEnv } from "../../../lib/server/config.js";
import { readLedger, writeLedger } from "../../../lib/server/ledger-file.js";
import { fail, failFromError, ok } from "../../../lib/server/respond.js";
import { getRun, stamp, withPayLock } from "../../../lib/server/runs.js";
import { findToken, knownTokens, parseAmount } from "../../../lib/units.js";
import { agentAccount, agentBalances } from "./agent-wallet.js";

export const runtime = "nodejs";

/** A CONFIRM press older than this (or from the future) doesn't count. */
const CONFIRM_MAX_AGE_MS = 120_000;
const CONFIRM_MAX_SKEW_MS = 5_000;

const policyJson = (p: PolicyResult): PolicyJson => p;

function setup() {
  const chain = chainConfig();
  const pol = policyEnv();
  const token = findToken(knownTokens(chain.usdcAddress), "USDC")!;
  const cfg = {
    allowedTokens: pol.allowedTokens,
    paymentCap: parseAmount(pol.paymentCapUsdc, token.decimals),
    dailyCap: parseAmount(pol.dailyCapUsdc, token.decimals),
  };
  return { chain, pol, token, cfg };
}

export async function GET(req: Request): Promise<Response> {
  let s;
  let account;
  try {
    s = setup();
  } catch (e) {
    return failFromError(e, "chain", null);
  }
  try {
    account = agentAccount();
  } catch (e) {
    return failFromError(e, "agent-wallet", null);
  }
  const url = new URL(req.url);
  const amountParam = url.searchParams.get("amount");
  const tokenParam = url.searchParams.get("token") ?? s.token.symbol;

  let ledger;
  try {
    ledger = await readLedger(s.pol.ledgerPath);
  } catch (e) {
    return fail(500, "error", (e as Error).message);
  }
  const today = dayKey(new Date());
  const spent = spentToday(ledger, s.token.symbol, today);
  const bal = await agentBalances(s.chain.rpcUrl, account.address, s.token.address);
  const wallet: WalletJson = {
    address: account.address,
    tokenBalance: bal.token?.toString() ?? null,
    ethBalance: bal.eth?.toString() ?? null,
    spentToday: spent.toString(),
    paymentCap: s.cfg.paymentCap.toString(),
    dailyCap: s.cfg.dailyCap.toString(),
    decimals: s.token.decimals,
    symbol: s.token.symbol,
    rpcHost: s.chain.rpcHost,
  };
  let policy: PolicyJson | null = null;
  if (amountParam !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(amountParam)) return fail(400, "bad_request", "amount must be base units");
    policy = policyJson(
      evaluatePolicy(s.cfg, {
        amount: BigInt(amountParam),
        token: tokenParam,
        spentToday: spent,
        tokenBalance: bal.token,
        ethBalance: bal.eth,
        gasDropWei: s.chain.gasDropWei,
      }),
    );
  }
  return ok({ wallet, policy });
}

export async function POST(req: Request): Promise<Response> {
  // 1. zod
  const parsed = PayRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "bad_request", "bad pay request");
  const { runId, session, claim, confirm } = parsed.data;
  const run = getRun(runId);
  stamp(run, "payRequested");

  let s;
  let account;
  try {
    s = setup();
  } catch (e) {
    return failFromError(e, "chain", run);
  }
  try {
    account = agentAccount();
  } catch (e) {
    return failFromError(e, "agent-wallet", run);
  }
  if (session.chainId !== s.chain.chainId) return fail(400, "bad_request", "wrong chain");
  if (!isAddressEqual(session.token as Address, s.token.address)) return fail(400, "policy_denied", "token not allowed");
  if (confirm.sessionId !== session.sessionId) return fail(400, "bad_request", "confirm is for another session");
  const amount = BigInt(session.amount);
  const destination = getAddress(claim.destination);
  if (isAddressEqual(destination, account.address)) return fail(400, "bad_request", "destination is the agent wallet");

  // 2. BBS proof vs issuer key + recomputed bindingDigest (never the browser's digest)
  let verified: { tier: string; epoch: string };
  let issuerPub: string;
  try {
    issuerPub = await issuerPublicKey();
  } catch (e) {
    return failFromError(e, "issuer", run);
  }
  try {
    await initCredential();
    const digest = bindingDigest({
      sessionNonce: session.sessionNonce,
      destination,
      chainId: session.chainId,
      token: session.token,
      amount: session.amount,
    });
    verified = await verifyProof(claim.credentialProof, issuerPub, digest);
  } catch (e) {
    const r = await failFromError(e, "credential", run);
    if (r.status === 502) return fail(403, "proof_invalid", "recipient proof did not verify for this payment");
    return r;
  }
  if (verified.tier !== "orb") return fail(403, "proof_invalid", `credential tier ${verified.tier} is not Proof of Human`);
  stamp(run, "proofVerified");

  return withPayLock(async () => {
    // 3. policy (ledger + balances read inside the lock)
    let ledger;
    try {
      ledger = await readLedger(s.pol.ledgerPath);
    } catch (e) {
      return fail(500, "error", (e as Error).message);
    }
    if (hasPaidSession(ledger, session.sessionId)) return fail(409, "already_paid", "this session was already paid");
    const today = dayKey(new Date());
    const bal = await agentBalances(s.chain.rpcUrl, account.address, s.token.address);
    const policy = evaluatePolicy(s.cfg, {
      amount,
      token: s.token.symbol,
      spentToday: spentToday(ledger, s.token.symbol, today),
      tokenBalance: bal.token,
      ethBalance: bal.eth,
      gasDropWei: s.chain.gasDropWei,
    });
    run.policy = policy;
    if (policy.decision === "deny") {
      run.decision = "policy_denied";
      const why = policy.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ");
      return fail(403, "policy_denied", `policy denied: ${why}`);
    }

    // 4. physical confirm for this session
    const age = Date.now() - confirm.at;
    if (age > CONFIRM_MAX_AGE_MS || age < -CONFIRM_MAX_SKEW_MS) {
      return fail(403, "bad_request", "confirm press is stale; press CONFIRM again");
    }

    // 5. Agent Pass (single-use, bound to exactly this payment)
    let approvalUsed = false;
    if (policy.decision === "needs_approval") {
      let approved: boolean;
      try {
        approved = consumeApproval({ sessionId: session.sessionId, amount: session.amount, token: s.token.address.toLowerCase() });
      } catch (e) {
        return failFromError(e, "agent-pass", run);
      }
      if (!approved) {
        run.decision = "approval_required";
        return fail(403, "approval_required", "over the cap: a World Agent Pass approval for exactly this payment is required");
      }
      approvalUsed = true;
    }

    // 6. sign + send
    stamp(run, "signing");
    let result;
    try {
      result = await payToDestination({
        account,
        destination,
        amount,
        token: s.token.address,
        gasDropWei: s.chain.gasDropWei,
        transport: http(s.chain.rpcUrl, { timeout: 30_000 }),
      });
    } catch (e) {
      const msg = (e as Error).message ?? "payment failed";
      // Fail closed for the caps: unless the error is a pre-send check, count the amount as spent.
      if (!/^pay: (insufficient|amount|negative)/.test(msg)) {
        await writeLedger(
          s.pol.ledgerPath,
          recordSpend(ledger, { sessionId: session.sessionId, token: s.token.symbol, amount: session.amount, txHash: "unknown", at: new Date().toISOString() }, today),
        ).catch(() => undefined);
      }
      run.decision = "chain_error";
      return fail(502, "chain_error", msg, { dependency: "chain" });
    }
    stamp(run, "paid");

    // 7. ledger
    await writeLedger(
      s.pol.ledgerPath,
      recordSpend(ledger, { sessionId: session.sessionId, token: s.token.symbol, amount: session.amount, txHash: result.transferHash, at: new Date().toISOString() }, today),
    );
    run.payment = {
      sessionId: session.sessionId,
      transferHash: result.transferHash,
      gasDropHash: result.gasDropHash,
      amount: session.amount,
      token: s.token.symbol,
    };
    run.decision = "paid";

    return ok({
      transferHash: result.transferHash,
      gasDropHash: result.gasDropHash,
      destination,
      amountBase: session.amount,
      symbol: s.token.symbol,
      from: account.address,
      verified,
      policy: policyJson(policy),
      approvalUsed,
      rpcHost: s.chain.rpcHost,
      rpcCalls: [
        "eth_call USDC.balanceOf(agent wallet) x2",
        "eth_getBalance(agent wallet) x2",
        "eth_sendRawTransaction USDC.transfer -> one-time address",
        "eth_sendRawTransaction ETH gas drop -> one-time address",
        "eth_getTransactionReceipt x2",
      ],
    });
  });
}
