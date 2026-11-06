// Pay protocol v2: two round trips over the unchanged relay (probe -> claim frames, ciphertext only).
//
// Round 1 (face only): payer seals {embedding, nonce} to every online peer. Only a phone whose owner's
//   template matches answers with a sealed "match". The payer needs EXACTLY one match, then drops the
//   picture and the embedding. The probe carries no amount, token or chain.
// Round 2 (face after the spoken amount; CPay QR directly): payer seals a "quote" {chainId, token, amount}
//   to that one peer, echoing EITHER the matchSecret from that peer's sealed match (face; never the round-1
//   nonce, which every probed phone saw) OR the qrSecret printed in the CPay QR the payer scanned (QR). The peer answers with a "claim": a fresh one-time (stealth) address + a BBS proof
//   bound to bindingDigest({sessionNonce, destination, chainId, token, amount}). The payer verifies it.
//
// Every round uses a fresh relay sessionId, a fresh payer X25519 key and a fresh 32-byte nonce, and its own
// seal context, so a body from one round can never be opened as another.
import { equalBytes } from "@noble/ciphers/utils.js";
import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { bytesToHex, decodeEmbedding, encodeEmbedding } from "./encoding.js";
import { DEFAULT_MATCH_THRESHOLD, isMatch } from "./face.js";
import {
  Address,
  Base64,
  Hex32,
  UintString,
  type ClaimDelivery,
  type ClaimRequest,
  type ProbeDelivery,
  type ProbeRequest,
} from "./messages.js";
import { generateKeyPair, open, seal } from "./seal.js";
import type { Peer } from "./session.js";

/** How long the payer waits for each round's answers. */
export const PAY2_LIMITS = {
  /** Round 1: collect "match" answers this long, then require exactly one. */
  matchWaitMs: 4_000,
  /** Round 2: the claim (proof generation on the recipient's phone) must arrive within this. */
  claimWaitMs: 8_000,
  /** Recipient: a round-1 match is remembered this long, so a quote referring to it is answered. */
  matchMemoryMs: 120_000,
  /** Recipient: at most one QR quote is answered per this window (proofs cost CPU; addresses are a resource). */
  qrQuoteMinIntervalMs: 5_000,
  /** Recipient: at most this many QR quotes per displayed qrSecret; then the QR must be re-shown (new secret). */
  qrQuotesPerSecret: 5,
} as const;

/** 16 random bytes as lowercase hex: the per-display secret in a CPay QR (`cpay:1:<peerId>.<pub>.<qrSecret>`). */
export const QrSecret = z.string().regex(/^[0-9a-f]{32}$/, "expected 16-byte lowercase hex");

/** A fresh per-display QR secret. Hex (not base64url) keeps the whole QR in QR alphanumeric mode once upper-cased. */
export function newQrSecret(): string {
  return bytesToHex(randomBytes(16));
}

/**
 * The CPay QR text. Upper-cased on purpose: every character is then in the QR alphanumeric set, so the code is
 * version 6 (41x41) at ECC M instead of version 8 in byte mode, which the glasses' QVGA camera reads more
 * reliably. parseQr lower-cases it back.
 */
export function cpayQrText(peerId: string, pub: string, qrSecret: string): string {
  return `cpay:1:${peerId}.${pub}.${QrSecret.parse(qrSecret)}`.toUpperCase();
}

export const faceProbeContext = (sessionId: string): string => `v2/face-probe:${sessionId}`;
export const matchContext = (sessionId: string): string => `v2/match:${sessionId}`;
export const quoteContext = (sessionId: string): string => `v2/quote:${sessionId}`;
export const claim2Context = (sessionId: string): string => `v2/claim:${sessionId}`;

// ---- sealed bodies ----

export const FaceProbeBody = z.strictObject({
  v: z.literal(2),
  sessionNonce: Hex32,
  /** base64 of little-endian Float32 values (SFace, 128-d); discarded by the recipient after one compare */
  embedding: Base64.min(1).max(8 * 1024),
});
export type FaceProbeBody = z.infer<typeof FaceProbeBody>;

export const MatchBody = z.strictObject({
  v: z.literal(2),
  /** echoes the round-1 nonce */
  sessionNonce: Hex32,
  /**
   * Fresh random secret from the matching phone, seen only by the payer (sealed). The quote must echo it.
   * NOT the round-1 nonce: every probed phone saw that nonce and could replay it in a quote.
   */
  matchSecret: Hex32,
});
export type MatchBody = z.infer<typeof MatchBody>;

export const QuoteBody = z
  .strictObject({
    v: z.literal(2),
    /** fresh for round 2; bound into the proof */
    sessionNonce: Hex32,
    /** face path: the matchSecret from this peer's sealed match */
    matchSecret: Hex32.optional(),
    /** CPay QR path: the per-display secret printed in the QR the payer scanned */
    qrSecret: QrSecret.optional(),
    chainId: z.number().int().positive(),
    token: Address,
    /** base units */
    amount: UintString,
  })
  .refine((q) => (q.matchSecret === undefined) !== (q.qrSecret === undefined), "exactly one of matchSecret / qrSecret");
export type QuoteBody = z.infer<typeof QuoteBody>;

export const Claim2Body = z.strictObject({
  v: z.literal(2),
  sessionNonce: Hex32,
  /** fresh one-time stealth address, generated by the recipient; never reused */
  destination: Address,
  /** serialised BBS presentation (@cpay/credential prove) over bindingDigest */
  credentialProof: z.string().min(1).max(64 * 1024),
});
export type Claim2Body = z.infer<typeof Claim2Body>;

// ---- payer side ----

export interface RoundSession {
  sessionId: string;
  sessionNonce: string;
  /** fresh per round; never reused */
  secretKey: Uint8Array;
  payerPub: string;
  peers: Peer[];
}

function newRound(peers: Peer[]): RoundSession {
  if (peers.length === 0) throw new Error("pay2: no peers");
  const kp = generateKeyPair();
  return {
    sessionId: crypto.randomUUID(),
    sessionNonce: bytesToHex(randomBytes(32)),
    secretKey: kp.secretKey,
    payerPub: kp.publicKey,
    peers: [...peers],
  };
}

/** Round 1: one sealed face probe per online peer. The caller drops `embedding` right after this. */
export function buildFaceProbe(peers: Peer[], embedding: ArrayLike<number>): { round: RoundSession; message: ProbeRequest } {
  const round = newRound(peers);
  const body = FaceProbeBody.parse({ v: 2, sessionNonce: round.sessionNonce, embedding: encodeEmbedding(embedding) });
  const ctx = faceProbeContext(round.sessionId);
  const items = round.peers.map((p) => ({ peerId: p.peerId, box: seal(round.secretKey, p.pub, ctx, body) }));
  return { round, message: { type: "probe", sessionId: round.sessionId, payerPub: round.payerPub, items } };
}

/** Trial-decrypt one round-1 answer; returns the peer that matched and its secret, or null. */
export function openMatch(round: RoundSession, msg: ClaimDelivery): { peer: Peer; matchSecret: string } | null {
  if (msg.sessionId !== round.sessionId) return null;
  const ctx = matchContext(round.sessionId);
  for (const peer of round.peers) {
    let raw: unknown;
    try {
      raw = open(round.secretKey, peer.pub, ctx, msg.box);
    } catch {
      continue;
    }
    const parsed = MatchBody.safeParse(raw);
    if (!parsed.success || parsed.data.sessionNonce !== round.sessionNonce) return null;
    return { peer, matchSecret: parsed.data.matchSecret };
  }
  return null;
}

export type MatchResolution =
  | { ok: true; peer: Peer; matchSecret: string }
  | { ok: false; reason: "none" | "multiple"; count: number };

/** Exactly-one rule over everything received in the match window (duplicates from one peer count once). */
export function resolveMatches(round: RoundSession, msgs: readonly ClaimDelivery[]): MatchResolution {
  const ids = new Map<string, { peer: Peer; matchSecret: string }>();
  for (const m of msgs) {
    const p = openMatch(round, m);
    if (p && !ids.has(p.peer.peerId)) ids.set(p.peer.peerId, p);
  }
  const peers = [...ids.values()];
  if (peers.length === 1) return { ok: true, peer: peers[0]!.peer, matchSecret: peers[0]!.matchSecret };
  return { ok: false, reason: peers.length === 0 ? "none" : "multiple", count: peers.length };
}

export interface QuoteInput {
  peer: Peer;
  chainId: number;
  token: string;
  /** base units */
  amount: bigint | string;
  /** face path: the secret from the round-1 match */
  matchSecret?: string;
  /** CPay QR path: the secret from the scanned QR */
  qrSecret?: string;
}

export interface QuoteSession extends RoundSession {
  chainId: number;
  token: string;
  amount: string;
}

/** Round 2: ask the one peer for a one-time address + proof bound to this exact payment. */
export function buildQuote(input: QuoteInput): { round: QuoteSession; message: ProbeRequest } {
  const r = newRound([input.peer]);
  const amount = typeof input.amount === "bigint" ? input.amount.toString(10) : input.amount;
  const body = QuoteBody.parse({
    v: 2,
    sessionNonce: r.sessionNonce,
    ...(input.matchSecret ? { matchSecret: input.matchSecret } : {}),
    ...(input.qrSecret ? { qrSecret: input.qrSecret } : {}),
    chainId: input.chainId,
    token: input.token,
    amount,
  });
  const round: QuoteSession = { ...r, chainId: body.chainId, token: body.token, amount: body.amount };
  const box = seal(round.secretKey, input.peer.pub, quoteContext(round.sessionId), body);
  return {
    round,
    message: { type: "probe", sessionId: round.sessionId, payerPub: round.payerPub, items: [{ peerId: input.peer.peerId, box }] },
  };
}

/**
 * Open the round-2 claim (from the quoted peer only). Returns the body, or null if it doesn't open, is
 * malformed, or carries the wrong nonce. The caller MUST still verifyProof against
 * bindingDigest({sessionNonce, destination, chainId, token, amount}) before paying.
 */
export function openClaim2(round: QuoteSession, msg: ClaimDelivery): Claim2Body | null {
  if (msg.sessionId !== round.sessionId) return null;
  const peer = round.peers[0]!;
  let raw: unknown;
  try {
    raw = open(round.secretKey, peer.pub, claim2Context(round.sessionId), msg.box);
  } catch {
    return null;
  }
  const parsed = Claim2Body.safeParse(raw);
  if (!parsed.success || parsed.data.sessionNonce !== round.sessionNonce) return null;
  return parsed.data;
}

// ---- recipient side ----

export type Incoming = { kind: "face"; body: FaceProbeBody } | { kind: "quote"; body: QuoteBody } | { kind: "unknown" };

/** Open any v2 probe addressed to this recipient's connection key. Never throws. */
export function openIncoming(secretKey: Uint8Array, msg: ProbeDelivery): Incoming {
  try {
    const parsed = FaceProbeBody.safeParse(open(secretKey, msg.payerPub, faceProbeContext(msg.sessionId), msg.box));
    if (parsed.success) return { kind: "face", body: parsed.data };
  } catch {
    /* not a face probe */
  }
  try {
    const parsed = QuoteBody.safeParse(open(secretKey, msg.payerPub, quoteContext(msg.sessionId), msg.box));
    if (parsed.success) return { kind: "quote", body: parsed.data };
  } catch {
    /* not a quote */
  }
  return { kind: "unknown" };
}

/** Compare the probe with the owner's template. The decoded embedding is zeroed right after. */
export function faceMatches(body: FaceProbeBody, template: ArrayLike<number>, threshold = DEFAULT_MATCH_THRESHOLD): boolean {
  let probe: Float32Array | null = null;
  try {
    probe = decodeEmbedding(body.embedding);
    return isMatch(probe, template, threshold);
  } catch {
    return false;
  } finally {
    probe?.fill(0);
  }
}

/**
 * Answer a face probe that matched. Non-matching phones send nothing. Returns the sealed reply and a fresh
 * matchSecret; the recipient remembers ONLY the secret (in memory) to recognise the payer's quote.
 */
export function buildMatch(
  secretKey: Uint8Array,
  probe: Pick<ProbeDelivery, "sessionId" | "payerPub">,
  body: FaceProbeBody,
): { message: ClaimRequest; matchSecret: string } {
  const matchSecret = bytesToHex(randomBytes(32));
  const m: MatchBody = { v: 2, sessionNonce: body.sessionNonce, matchSecret };
  return {
    message: { type: "claim", sessionId: probe.sessionId, box: seal(secretKey, probe.payerPub, matchContext(probe.sessionId), m) },
    matchSecret,
  };
}

/** Answer a quote with a fresh one-time address + proof (the caller builds both, bound to the quote). */
export function buildClaim2(
  secretKey: Uint8Array,
  probe: Pick<ProbeDelivery, "sessionId" | "payerPub">,
  body: Claim2Body,
): ClaimRequest {
  const parsed = Claim2Body.parse(body);
  return { type: "claim", sessionId: probe.sessionId, box: seal(secretKey, probe.payerPub, claim2Context(probe.sessionId), parsed) };
}

/** Constant-time equality of two QR secrets (lowercase hex). False for anything malformed. */
export function qrSecretEquals(a: string, b: string): boolean {
  if (!QrSecret.safeParse(a).success || !QrSecret.safeParse(b).success) return false;
  return equalBytes(hexToBytes(a), hexToBytes(b));
}

/**
 * Recipient rule for answering a quote: only if it echoes the matchSecret of a face match this phone made in the last
 * PAY2_LIMITS.matchMemoryMs, or its qrSecret equals the secret of the CPay QR this phone has ON SCREEN right now
 * (constant-time compare). Knowing the peerId + pub alone (e.g. from the relay's peers list) is not enough.
 */
export function shouldAnswerQuote(
  q: QuoteBody,
  state: { recentMatches: ReadonlyMap<string, number>; showingCpayQr: boolean; qrSecret: string | null; now: number },
): boolean {
  if (q.matchSecret) {
    const at = state.recentMatches.get(q.matchSecret);
    return at !== undefined && state.now - at <= PAY2_LIMITS.matchMemoryMs;
  }
  if (!q.qrSecret || !state.showingCpayQr || !state.qrSecret) return false;
  return qrSecretEquals(q.qrSecret, state.qrSecret);
}

export type QrAdmit = "ok" | "too_soon" | "exhausted";

/**
 * The recipient's per-display QR secret + its rate limit (memory only). One secret at a time: rotate() each time
 * the QR is shown and after every answered QR quote, so one scan of the QR is good for one payment.
 */
export class QrSecretBook {
  private secret: string | null = null;
  private uses = 0;
  private lastAt = Number.NEGATIVE_INFINITY;

  current(): string | null {
    return this.secret;
  }
  rotate(): string {
    this.secret = newQrSecret();
    this.uses = 0;
    return this.secret;
  }
  clear(): void {
    this.secret = null;
    this.uses = 0;
  }
  /**
   * Call only after shouldAnswerQuote passed for a QR quote: <= 1 per PAY2_LIMITS.qrQuoteMinIntervalMs (across
   * secrets) and <= PAY2_LIMITS.qrQuotesPerSecret per secret. Counts the attempt when admitted.
   */
  admit(now: number): QrAdmit {
    if (now - this.lastAt < PAY2_LIMITS.qrQuoteMinIntervalMs) return "too_soon";
    if (this.uses >= PAY2_LIMITS.qrQuotesPerSecret) return "exhausted";
    this.uses++;
    this.lastAt = now;
    return "ok";
  }
}
