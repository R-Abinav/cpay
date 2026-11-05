// Recipient-side probe handling: open -> local face match -> (match) fresh one-time destination + bound BBS proof
// -> sealed claim. No match -> silence (nothing is sent). Dependencies are injected so this is unit-testable.
import {
  bindingDigest,
  buildClaim,
  openProbe,
  probeMatches,
  type ClaimRequest,
  type ProbeBody,
  type ProbeDelivery,
} from "@cpay/protocol";

export interface Destination {
  address: `0x${string}`;
  ephemeralPublicKey: `0x${string}`;
  viewTag: `0x${string}`;
}

export interface RecipientDeps {
  /** X25519 secret of the current relay connection */
  secretKey: Uint8Array;
  template: ArrayLike<number>;
  threshold: number;
  /** only answer probes for this chain + token */
  chainId: number;
  tokens: readonly string[];
  createDestination: () => Destination;
  /** BBS presentation bound to the digest (from @cpay/credential prove) */
  prove: (digest: Uint8Array) => Promise<string>;
}

export interface OpenedProbe {
  delivery: ProbeDelivery;
  body: ProbeBody;
  receivedAt: number;
}

export type ProbeOutcome =
  | { kind: "unreadable" }
  | { kind: "wrong_chain"; probe: OpenedProbe }
  | { kind: "no_match"; probe: OpenedProbe }
  | { kind: "claimed"; probe: OpenedProbe; claim: ClaimRequest; destination: Destination };

export function readProbe(secretKey: Uint8Array, msg: ProbeDelivery): OpenedProbe | null {
  try {
    return { delivery: msg, body: openProbe(secretKey, msg), receivedAt: Date.now() };
  } catch {
    return null;
  }
}

function acceptable(deps: RecipientDeps, p: OpenedProbe): boolean {
  return p.body.chainId === deps.chainId && deps.tokens.some((t) => t.toLowerCase() === p.body.token.toLowerCase()) && p.body.mode === "lite";
}

/** Build the claim for an opened probe: fresh destination + proof bound to bindingDigest(...). */
export async function claimFor(deps: RecipientDeps, p: OpenedProbe): Promise<{ claim: ClaimRequest; destination: Destination }> {
  const destination = deps.createDestination();
  const digest = bindingDigest({
    sessionNonce: p.body.sessionNonce,
    destination: destination.address,
    chainId: p.body.chainId,
    token: p.body.token,
    amount: p.body.amount,
  });
  const credentialProof = await deps.prove(digest);
  const claim = buildClaim(deps.secretKey, p.delivery, {
    v: 1,
    sessionNonce: p.body.sessionNonce,
    destination: destination.address,
    credentialProof,
  });
  return { claim, destination };
}

/** Automatic path: answer only when the face in the probe matches the owner's template. */
export async function handleProbe(deps: RecipientDeps, msg: ProbeDelivery): Promise<ProbeOutcome> {
  const p = readProbe(deps.secretKey, msg);
  if (!p) return { kind: "unreadable" };
  if (!acceptable(deps, p)) return { kind: "wrong_chain", probe: p };
  if (!probeMatches(p.body, deps.template, deps.threshold)) return { kind: "no_match", probe: p };
  const { claim, destination } = await claimFor(deps, p);
  return { kind: "claimed", probe: p, claim, destination };
}

/** QR fallback: the owner explicitly claims a probe they received (no face match needed; still bound + proven). */
export async function handleQrClaim(deps: RecipientDeps, p: OpenedProbe): Promise<{ claim: ClaimRequest; destination: Destination }> {
  if (!acceptable(deps, p)) throw new Error("probe is for another chain or token");
  return claimFor(deps, p);
}

export const QR_PREFIX = "cpay:claim:";
export const qrPayload = (sessionId: string) => `${QR_PREFIX}${sessionId}`;
/** Short typed code: first 8 hex chars of the session id. */
export const shortCode = (sessionId: string) => sessionId.replace(/-/g, "").slice(0, 8).toUpperCase();

/** Resolve a scanned QR payload or a typed short code against the probes this phone received. */
export function findProbeForCode(probes: readonly OpenedProbe[], input: string): OpenedProbe | null {
  const v = input.trim();
  if (v.startsWith(QR_PREFIX)) {
    const id = v.slice(QR_PREFIX.length);
    return probes.find((p) => p.delivery.sessionId === id) ?? null;
  }
  const code = v.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (code.length < 6) return null;
  const hits = probes.filter((p) => shortCode(p.delivery.sessionId).startsWith(code));
  return hits.length === 1 ? hits[0]! : null;
}
