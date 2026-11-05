// Probe/claim session helpers for both sides of the relay.
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesToHex, decodeEmbedding, encodeEmbedding } from "./encoding.js";
import { isMatch, DEFAULT_MATCH_THRESHOLD } from "./face.js";
import {
  ClaimBodySchema,
  ProbeBodySchema,
  type ClaimBody,
  type ClaimDelivery,
  type ClaimRequest,
  type Mode,
  type ProbeBody,
  type ProbeDelivery,
  type ProbeRequest,
} from "./messages.js";
import { claimContext, generateKeyPair, open, probeContext, seal } from "./seal.js";

export interface Peer {
  peerId: string;
  pub: string;
}

export interface PayerSession {
  sessionId: string;
  sessionNonce: string;
  /** fresh per session; never reused */
  secretKey: Uint8Array;
  payerPub: string;
  /** the peers this session was probed to (used to trial-decrypt claims) */
  peers: Peer[];
  chainId: number;
  token: string;
  amount: string;
  mode: Mode;
}

export interface BuildProbeInput {
  peers: Peer[];
  embedding: ArrayLike<number>;
  chainId: number;
  token: string;
  /** base units */
  amount: bigint | string;
  mode?: Mode;
}

/** Start a payer session: fresh X25519 key, uuid session id, 32-byte nonce, one sealed probe per peer. */
export function buildProbe(input: BuildProbeInput): { session: PayerSession; message: ProbeRequest } {
  if (input.peers.length === 0) throw new Error("buildProbe: no peers");
  const kp = generateKeyPair();
  const sessionId = crypto.randomUUID();
  const sessionNonce = bytesToHex(randomBytes(32));
  const amount = typeof input.amount === "bigint" ? input.amount.toString(10) : input.amount;
  const body: ProbeBody = ProbeBodySchema.parse({
    v: 1,
    sessionNonce,
    embedding: encodeEmbedding(input.embedding),
    chainId: input.chainId,
    token: input.token,
    amount,
    mode: input.mode ?? "lite",
  });
  const ctx = probeContext(sessionId);
  const items = input.peers.map((p) => ({ peerId: p.peerId, box: seal(kp.secretKey, p.pub, ctx, body) }));
  const session: PayerSession = {
    sessionId,
    sessionNonce,
    secretKey: kp.secretKey,
    payerPub: kp.publicKey,
    peers: [...input.peers],
    chainId: body.chainId,
    token: body.token,
    amount: body.amount,
    mode: body.mode,
  };
  return { session, message: { type: "probe", sessionId, payerPub: kp.publicKey, items } };
}

export interface OpenedClaim {
  peerId: string;
  body: ClaimBody;
}

/**
 * Trial-decrypt a claim against every probed peer. Returns the claim and which peer sent it,
 * or null if no peer's key opens it, the body is invalid, or the nonce doesn't match this session.
 */
export function openClaim(session: PayerSession, msg: ClaimDelivery): OpenedClaim | null {
  if (msg.sessionId !== session.sessionId) return null;
  const ctx = claimContext(session.sessionId);
  for (const peer of session.peers) {
    let raw: unknown;
    try {
      raw = open(session.secretKey, peer.pub, ctx, msg.box);
    } catch {
      continue;
    }
    const parsed = ClaimBodySchema.safeParse(raw);
    if (!parsed.success) return null;
    if (parsed.data.sessionNonce !== session.sessionNonce) return null;
    return { peerId: peer.peerId, body: parsed.data };
  }
  return null;
}

export type ClaimResolution =
  | { ok: true; claim: OpenedClaim }
  | { ok: false; reason: "none" | "multiple"; count: number };

/** Exactly-one rule: zero or more than one valid claim aborts (QR fallback). */
export function resolveClaims(session: PayerSession, msgs: readonly ClaimDelivery[]): ClaimResolution {
  const valid = msgs.map((m) => openClaim(session, m)).filter((c): c is OpenedClaim => c !== null);
  if (valid.length === 1) return { ok: true, claim: valid[0]! };
  return { ok: false, reason: valid.length === 0 ? "none" : "multiple", count: valid.length };
}

// ---- recipient side ----

/** Open a probe addressed to this recipient's connection key. Throws if it can't be opened or validated. */
export function openProbe(secretKey: Uint8Array, msg: ProbeDelivery): ProbeBody {
  return ProbeBodySchema.parse(open(secretKey, msg.payerPub, probeContext(msg.sessionId), msg.box));
}

/** Decode the probe's embedding and compare it with the owner's template. */
export function probeMatches(body: ProbeBody, template: ArrayLike<number>, threshold = DEFAULT_MATCH_THRESHOLD): boolean {
  let probe: Float32Array;
  try {
    probe = decodeEmbedding(body.embedding);
  } catch {
    return false;
  }
  return isMatch(probe, template, threshold);
}

/** Seal a claim back to the payer, from this recipient's connection key. */
export function buildClaim(
  secretKey: Uint8Array,
  probe: Pick<ProbeDelivery, "sessionId" | "payerPub">,
  body: ClaimBody,
): ClaimRequest {
  const parsed = ClaimBodySchema.parse(body);
  return {
    type: "claim",
    sessionId: probe.sessionId,
    box: seal(secretKey, probe.payerPub, claimContext(probe.sessionId), parsed),
  };
}
