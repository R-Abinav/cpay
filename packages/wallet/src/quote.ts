// Pay protocol v2, round 2 (packages/protocol/src/pay2.ts): the recipient answers a quote with a fresh
// one-time address + a BBS proof bound to bindingDigest; the payer verifies it against its OWN round fields.
import { currentEpoch, prove, verifyProof, type Card, type Epoch, type Tier } from "@cpay/credential";
import { Claim2Body, QuoteBody, bindingDigest, type QuoteSession } from "@cpay/protocol";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import type { StealthKeys } from "@cpay/stealth";
import { newOneTimeDestination } from "./onetime.js";

export interface AnswerQuoteParams {
  /** an opened quote this phone decided to answer (shouldAnswerQuote) */
  quote: QuoteBody;
  card: Card;
  issuerPublicKey: string;
  stealthKeys: StealthKeys;
}

/**
 * Recipient: a fresh one-time destination (persisted on this phone first, so the funds are always
 * recoverable) + a proof bound to exactly this payment. Pass the result to buildClaim2.
 */
export async function answerQuote(p: AnswerQuoteParams): Promise<Claim2Body> {
  const quote = QuoteBody.parse(p.quote);
  const dest = await newOneTimeDestination(p.stealthKeys);
  const digest = bindingDigest({
    sessionNonce: quote.sessionNonce,
    destination: dest.address,
    chainId: quote.chainId,
    token: quote.token,
    amount: quote.amount,
  });
  const credentialProof = await prove(p.card, p.issuerPublicKey, digest);
  return Claim2Body.parse({ v: 2, sessionNonce: quote.sessionNonce, destination: dest.address, credentialProof });
}

export type Claim2Check =
  | { ok: true; destination: Address; tier: Tier; epoch: Epoch }
  | { ok: false; reason: "nonce" | "destination" | "proof" | "epoch" };

export interface VerifyClaim2Params {
  /** the payer's own round-2 state from buildQuote */
  round: QuoteSession;
  /** from openClaim2 */
  claim: Claim2Body;
  issuerPublicKey: string;
  /** defaults to now; the proof's epoch must equal currentEpoch(now) */
  now?: Date;
}

/**
 * Payer: never pay unless this returns ok. The digest is recomputed from the payer's own round
 * (sessionNonce, chainId, token, amount); only the destination comes from the claim, and it is bound.
 */
export async function verifyClaim2(p: VerifyClaim2Params): Promise<Claim2Check> {
  const parsed = Claim2Body.safeParse(p.claim);
  if (!parsed.success || parsed.data.sessionNonce !== p.round.sessionNonce) return { ok: false, reason: "nonce" };
  const claim = parsed.data;
  if (!isAddress(claim.destination) || claim.destination.toLowerCase() === zeroAddress) {
    return { ok: false, reason: "destination" };
  }
  const destination = getAddress(claim.destination);
  let digest: Uint8Array;
  try {
    digest = bindingDigest({
      sessionNonce: p.round.sessionNonce,
      destination,
      chainId: p.round.chainId,
      token: p.round.token,
      amount: p.round.amount,
    });
  } catch {
    return { ok: false, reason: "destination" };
  }
  let revealed: { tier: Tier; epoch: Epoch };
  try {
    revealed = await verifyProof(claim.credentialProof, p.issuerPublicKey, digest);
  } catch {
    return { ok: false, reason: "proof" };
  }
  if (revealed.epoch !== currentEpoch(p.now ?? new Date())) return { ok: false, reason: "epoch" };
  return { ok: true, destination, tier: revealed.tier, epoch: revealed.epoch };
}
