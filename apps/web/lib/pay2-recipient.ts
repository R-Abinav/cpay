// Recipient side of pay protocol v2 (packages/protocol/src/pay2.ts), as one pure-ish handler with injected deps.
//   face probe  -> compare with the owner's template ON THIS PHONE -> match: sealed "match" + remember the nonce
//                                                                 -> no match: silence (nothing is sent)
//   quote       -> only for a recent match of ours (single use) or while our CPay QR is on screen
//                  -> fresh one-time address + BBS proof bound to the quote (answerQuote) -> sealed claim
// The probe body (embedding) is used for one compare and dropped. Nothing here logs or stores it.
import {
  PAY2_LIMITS,
  buildClaim2,
  buildMatch,
  faceMatches,
  openIncoming,
  shouldAnswerQuote,
  type Claim2Body,
  type ClaimRequest,
  type ProbeDelivery,
  type QuoteBody,
} from "@cpay/protocol";

export interface Pay2RecipientDeps {
  /** X25519 secret of the current relay connection */
  secretKey: Uint8Array;
  /** owner's face template (device only); null = not enrolled, face probes are ignored */
  template: ArrayLike<number> | null;
  threshold: number;
  /** only quotes for this chain + token are answered */
  chainId: number;
  token: string;
  showingCpayQr: () => boolean;
  /** matchSecret -> when we matched (memory only, this tab) */
  recentMatches: Map<string, number>;
  now: () => number;
  /** fresh one-time address + proof bound to the quote (packages/wallet answerQuote) */
  answer: (quote: QuoteBody) => Promise<Claim2Body>;
}

export type Pay2Outcome =
  | { kind: "ignored" }
  | { kind: "no_match" }
  | { kind: "matched"; reply: ClaimRequest }
  | { kind: "quote_refused"; why: "not_ours" | "wrong_chain" }
  | { kind: "claimed"; reply: ClaimRequest };

function prune(m: Map<string, number>, now: number): void {
  for (const [k, at] of m) if (now - at > PAY2_LIMITS.matchMemoryMs) m.delete(k);
}

export async function handlePay2Probe(deps: Pay2RecipientDeps, msg: ProbeDelivery): Promise<Pay2Outcome> {
  const now = deps.now();
  prune(deps.recentMatches, now);
  const inc = openIncoming(deps.secretKey, msg);

  if (inc.kind === "face") {
    if (!deps.template) return { kind: "ignored" };
    const hit = faceMatches(inc.body, deps.template, deps.threshold);
    if (!hit) return { kind: "no_match" };
    const { message, matchSecret } = buildMatch(deps.secretKey, msg, inc.body);
    deps.recentMatches.set(matchSecret, now);
    return { kind: "matched", reply: message };
  }

  if (inc.kind === "quote") {
    const q = inc.body;
    if (q.chainId !== deps.chainId || q.token.toLowerCase() !== deps.token.toLowerCase()) return { kind: "quote_refused", why: "wrong_chain" };
    if (!shouldAnswerQuote(q, { recentMatches: deps.recentMatches, showingCpayQr: deps.showingCpayQr(), now })) {
      return { kind: "quote_refused", why: "not_ours" };
    }
    // One quote per match: a payer can't harvest several one-time addresses from one look.
    if (q.matchSecret) deps.recentMatches.delete(q.matchSecret);
    const claim = await deps.answer(q);
    return { kind: "claimed", reply: buildClaim2(deps.secretKey, msg, claim) };
  }

  return { kind: "ignored" };
}
