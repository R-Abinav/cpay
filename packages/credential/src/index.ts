// @cpay/credential: BBS (IETF-draft BBS on BLS12-381) via @docknetwork/crypto-wasm-ts.
// STUB: interfaces only, owned by the identity agent. Every function throws until implemented.
// Card messages, fixed order: [s (hidden), tier, epoch]. The presentation header is bindingDigest(...) from @cpay/protocol.

const notImplemented = (): never => {
  throw new Error("not implemented");
};

/** Serialised values are opaque base64 strings so they can cross the relay and HTTP unchanged. */
export type Base64 = string;

export type Tier = "orb" | (string & {});
/** "YYYY-MM" */
export type Epoch = string;

export interface IssuerKeyPair {
  secretKey: Base64;
  publicKey: Base64;
}

/** Held only on the recipient's phone. */
export interface HolderSecret {
  s: Base64;
  /** blinding used for the commitment; needed to unblind */
  blinding: Base64;
}

export interface HolderCommitment {
  secret: HolderSecret;
  /** the blind-signature request / commitment C sent to the issuer */
  commitment: Base64;
}

export interface BlindSignature {
  signature: Base64;
  tier: Tier;
  epoch: Epoch;
}

/** The recipient's card: signature over [s, tier, epoch]. */
export interface Card {
  signature: Base64;
  secret: HolderSecret;
  tier: Tier;
  epoch: Epoch;
}

/** A presentation revealing tier + epoch, hiding s, bound to a bindingDigest. Goes into ClaimBody.credentialProof. */
export type Proof = Base64;

export interface VerifiedProof {
  tier: Tier;
  epoch: Epoch;
}

/** Load the WASM once before any other call (Node and browser). */
export function initCredential(): Promise<void> {
  return notImplemented();
}
export function issuerKeygen(): Promise<IssuerKeyPair> {
  return notImplemented();
}
export function holderCommit(): Promise<HolderCommitment> {
  return notImplemented();
}
export function issueBlind(
  _issuerSecretKey: Base64,
  _commitment: Base64,
  _revealed: { tier: Tier; epoch: Epoch },
): Promise<BlindSignature> {
  return notImplemented();
}
export function unblind(_sig: BlindSignature, _secret: HolderSecret, _issuerPublicKey: Base64): Promise<Card> {
  return notImplemented();
}
export function verifyCard(_card: Card, _issuerPublicKey: Base64): Promise<boolean> {
  return notImplemented();
}
export function prove(_card: Card, _issuerPublicKey: Base64, _bindingDigest: Uint8Array): Promise<Proof> {
  return notImplemented();
}
/** Returns the revealed attributes, or throws if the proof or binding is invalid. */
export function verifyProof(_proof: Proof, _issuerPublicKey: Base64, _bindingDigest: Uint8Array): Promise<VerifiedProof> {
  return notImplemented();
}
/** hash(C), used as the World ID signal at enrolment. */
export function commitmentSignal(_commitment: Base64): string {
  return notImplemented();
}
