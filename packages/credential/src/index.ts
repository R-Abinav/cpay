// @cpay/credential: BBS (IETF-draft BBS on BLS12-381) via @docknetwork/crypto-wasm-ts.
// The rest of the code never imports the library directly; it goes through this wrapper.
//
// Card messages, fixed order: [s (hidden), tier, epoch, blinding (hidden)].
//   - s: the holder secret. Never leaves the recipient's phone, never seen by the issuer.
//   - blinding: a second random hidden message. The library's BBS blind request is a Pedersen
//     commitment over the hidden messages with no extra randomness ("computationally hiding";
//     the README says a dummy attribute makes it perfectly hiding). We add that dummy attribute,
//     so C = h0^s * h3^blinding is perfectly hiding.
// The issuer verifies a proof of knowledge of the opening of C (over exactly indices 0 and 3),
// so the holder can't smuggle tier/epoch into the commitment, then blind-signs tier + epoch + C.
// Presentations reveal tier + epoch, hide s and blinding, and take bindingDigest(...) from
// @cpay/protocol as the composite proof's nonce (the "presentation header").
import {
  BBSBlindSignature,
  BBSSecretKey,
  BBSPublicKey,
  BBSSignature,
  BBSSignatureParams,
  CompositeProof,
  MetaStatements,
  ProofSpec,
  Statement,
  Statements,
  Witness,
  Witnesses,
  initializeWasm,
  isWasmInitialized,
} from "@docknetwork/crypto-wasm-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64ToBytes, bytesToBase64, bytesToHex } from "@cpay/protocol";

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
  /** the second hidden message that makes the commitment perfectly hiding; part of the card */
  blinding: Base64;
}

export interface HolderCommitment {
  secret: HolderSecret;
  /** the blind-signature request sent to the issuer: commitment C + proof of knowledge of its opening */
  commitment: Base64;
}

export interface BlindSignature {
  signature: Base64;
  tier: Tier;
  epoch: Epoch;
}

/** The recipient's card: signature over [s, tier, epoch, blinding]. */
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

// ---- constants ----

const IDX_S = 0;
const IDX_TIER = 1;
const IDX_EPOCH = 2;
const IDX_BLINDING = 3;
const MESSAGE_COUNT = 4;
const HIDDEN = [IDX_S, IDX_BLINDING];

/** Public, deterministic signature params: both sides derive the same generators from this label. */
export const PARAMS_LABEL = "cpay/v1/card-params";
const REQUEST_CONTEXT = utf8ToBytes("cpay/v1/blind-request");
const PRESENTATION_CONTEXT = utf8ToBytes("cpay/v1/presentation");
const EPOCH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const TIER_RE = /^[a-z0-9-]{1,32}$/;

// ---- helpers ----

let paramsCache: BBSSignatureParams | undefined;
function params(): BBSSignatureParams {
  requireInit();
  paramsCache ??= BBSSignatureParams.generate(MESSAGE_COUNT, utf8ToBytes(PARAMS_LABEL));
  return paramsCache;
}

function requireInit(): void {
  if (!isWasmInitialized()) throw new Error("credential: call initCredential() first");
}

function enc(m: Uint8Array): Uint8Array {
  return BBSSignature.encodeMessageForSigningConstantTime(m);
}

function checkRevealed(tier: Tier, epoch: Epoch): void {
  if (!TIER_RE.test(tier)) throw new Error("credential: bad tier");
  if (!EPOCH_RE.test(epoch)) throw new Error("credential: epoch must be YYYY-MM");
}

function revealedMap(tier: Tier, epoch: Epoch): Map<number, Uint8Array> {
  return new Map([
    [IDX_TIER, utf8ToBytes(tier)],
    [IDX_EPOCH, utf8ToBytes(epoch)],
  ]);
}

function cardMessages(card: Pick<Card, "secret" | "tier" | "epoch">): Uint8Array[] {
  return [
    base64ToBytes(card.secret.s),
    utf8ToBytes(card.tier),
    utf8ToBytes(card.epoch),
    base64ToBytes(card.secret.blinding),
  ];
}

function jsonToB64(o: unknown): Base64 {
  return bytesToBase64(utf8ToBytes(JSON.stringify(o)));
}

function b64ToJson(b: Base64): Record<string, unknown> {
  const v: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(b)));
  if (typeof v !== "object" || v === null) throw new Error("credential: malformed payload");
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new Error(`credential: missing ${k}`);
  return v;
}

function publicKeyOf(b64: Base64): BBSPublicKey {
  const pk = new BBSPublicKey(base64ToBytes(b64));
  if (!pk.isValid()) throw new Error("credential: invalid issuer public key");
  return pk;
}

function requestProofSpec(commitment: Uint8Array): ProofSpec {
  const statements = new Statements();
  statements.add(Statement.pedersenCommitmentG1(params().getParamsForIndices(HIDDEN), commitment));
  return new ProofSpec(statements, new MetaStatements(), [], REQUEST_CONTEXT);
}

interface ParsedRequest {
  c: Uint8Array;
  pok: Uint8Array;
}

function parseRequest(commitment: Base64): ParsedRequest {
  const o = b64ToJson(commitment);
  if (o.v !== 1) throw new Error("credential: unsupported request version");
  return { c: base64ToBytes(str(o, "c")), pok: base64ToBytes(str(o, "pok")) };
}

// ---- API ----

/** Load the WASM once before any other call (Node and browser). */
export async function initCredential(): Promise<void> {
  if (!isWasmInitialized()) await initializeWasm();
  params();
}

export async function issuerKeygen(): Promise<IssuerKeyPair> {
  await initCredential();
  const sk = BBSSecretKey.generate();
  return { secretKey: bytesToBase64(sk.bytes), publicKey: issuerPublicKey(bytesToBase64(sk.bytes)) };
}

/** Derive the issuer public key from its secret key (served at GET /issuer-key). */
export function issuerPublicKey(issuerSecretKey: Base64): Base64 {
  const sk = new BBSSecretKey(base64ToBytes(issuerSecretKey));
  return bytesToBase64(sk.generatePublicKey(params()).bytes);
}

/** Holder (recipient phone): fresh random s + blinding. Prefer holderCommitFromSeed with passkey-derived bytes. */
export async function holderCommit(): Promise<HolderCommitment> {
  return holderCommitFromSeed(randomBytes(32), randomBytes(32));
}

/**
 * Holder (recipient phone): commitment C to [s, blinding] + a fresh proof of knowledge of its opening.
 * s and blinding are 32 bytes each, derived on the phone from the passkey (HKDF infos cpay/v1/bbs-holder
 * and cpay/v1/bbs-blinding), so the same passkey always gives the same C (commitmentHash is stable;
 * the proof of knowledge is re-randomised on every call). The library maps the bytes into the field.
 */
export async function holderCommitFromSeed(s: Uint8Array, blinding: Uint8Array): Promise<HolderCommitment> {
  await initCredential();
  if (!(s instanceof Uint8Array) || s.length !== 32) throw new Error("credential: s must be 32 bytes");
  if (!(blinding instanceof Uint8Array) || blinding.length !== 32) throw new Error("credential: blinding must be 32 bytes");
  const hidden = new Map([
    [IDX_S, s],
    [IDX_BLINDING, blinding],
  ]);
  const c = params().commitToMessagesConstantTime(hidden, true);
  const witnesses = new Witnesses();
  witnesses.add(Witness.pedersenCommitment([enc(s), enc(blinding)]));
  const pok = CompositeProof.generate(requestProofSpec(c), witnesses);
  return {
    secret: { s: bytesToBase64(s), blinding: bytesToBase64(blinding) },
    commitment: jsonToB64({ v: 1, c: bytesToBase64(c), pok: bytesToBase64(pok.bytes) }),
  };
}

/**
 * Issuer: verify the proof of knowledge of C's opening (hidden indices 0 and 3 only), then sign
 * [C, tier, epoch]. The issuer never sees s or blinding.
 */
export async function issueBlind(
  issuerSecretKey: Base64,
  commitment: Base64,
  revealed: { tier: Tier; epoch: Epoch },
): Promise<BlindSignature> {
  await initCredential();
  checkRevealed(revealed.tier, revealed.epoch);
  const { c, pok } = parseRequest(commitment);
  const res = new CompositeProof(pok).verify(requestProofSpec(c));
  if (!res.verified) throw new Error("credential: commitment proof of knowledge failed");
  const sk = new BBSSecretKey(base64ToBytes(issuerSecretKey));
  const sig = BBSBlindSignature.generate(c, revealedMap(revealed.tier, revealed.epoch), sk, params(), true);
  return { signature: bytesToBase64(sig.bytes), tier: revealed.tier, epoch: revealed.epoch };
}

/**
 * Holder: turn the blind signature into a card and verify it against the issuer key.
 * With BBS the commitment carries no separate randomness, so the blind signature already is a
 * regular signature over [s, tier, epoch, blinding]; "unblind" is assemble + verify. Throws if invalid.
 */
export async function unblind(sig: BlindSignature, secret: HolderSecret, issuerPublicKey: Base64): Promise<Card> {
  await initCredential();
  checkRevealed(sig.tier, sig.epoch);
  const card: Card = { signature: sig.signature, secret, tier: sig.tier, epoch: sig.epoch };
  if (!(await verifyCard(card, issuerPublicKey))) throw new Error("credential: issuer signature does not verify");
  return card;
}

export async function verifyCard(card: Card, issuerPublicKey: Base64): Promise<boolean> {
  await initCredential();
  try {
    const sig = new BBSSignature(base64ToBytes(card.signature));
    return sig.verify(cardMessages(card), publicKeyOf(issuerPublicKey), params(), true).verified;
  } catch {
    return false;
  }
}

/** Presentation: reveal tier + epoch, hide s + blinding, bound to bindingDigest (32 bytes). Fresh randomness each call. */
export async function prove(card: Card, issuerPublicKey: Base64, bindingDigest: Uint8Array): Promise<Proof> {
  await initCredential();
  if (bindingDigest.length !== 32) throw new Error("credential: bindingDigest must be 32 bytes");
  checkRevealed(card.tier, card.epoch);
  publicKeyOf(issuerPublicKey);
  const statements = new Statements();
  statements.add(Statement.bbsSignatureProverConstantTime(params(), revealedMap(card.tier, card.epoch), true));
  const spec = new ProofSpec(statements, new MetaStatements(), [], PRESENTATION_CONTEXT);
  const msgs = cardMessages(card);
  const unrevealed = new Map<number, Uint8Array>(HIDDEN.map((i) => [i, msgs[i]!]));
  const witnesses = new Witnesses();
  witnesses.add(Witness.bbsSignatureConstantTime(new BBSSignature(base64ToBytes(card.signature)), unrevealed, true));
  const proof = CompositeProof.generate(spec, witnesses, bindingDigest);
  return jsonToB64({ v: 1, tier: card.tier, epoch: card.epoch, proof: bytesToBase64(proof.bytes) });
}

/** Returns the revealed attributes, or throws if the proof or binding is invalid. */
export async function verifyProof(proof: Proof, issuerPublicKey: Base64, bindingDigest: Uint8Array): Promise<VerifiedProof> {
  await initCredential();
  if (bindingDigest.length !== 32) throw new Error("credential: bindingDigest must be 32 bytes");
  const o = b64ToJson(proof);
  if (o.v !== 1) throw new Error("credential: unsupported proof version");
  const tier = str(o, "tier");
  const epoch = str(o, "epoch");
  checkRevealed(tier, epoch);
  const statements = new Statements();
  statements.add(
    Statement.bbsSignatureVerifierConstantTime(params(), publicKeyOf(issuerPublicKey), revealedMap(tier, epoch), true),
  );
  const spec = new ProofSpec(statements, new MetaStatements(), [], PRESENTATION_CONTEXT);
  let verified = false;
  try {
    verified = new CompositeProof(base64ToBytes(str(o, "proof"))).verify(spec, bindingDigest).verified;
  } catch {
    verified = false;
  }
  if (!verified) throw new Error("credential: proof does not verify for this issuer and binding");
  return { tier, epoch };
}

/** hash(C), used as the World ID signal at enrolment: 0x-prefixed hex sha256 of the decoded request bytes. */
export function commitmentSignal(commitment: Base64): string {
  return "0x" + bytesToHex(sha256(base64ToBytes(commitment)));
}

/**
 * sha256 of the commitment C alone (hex, no 0x), excluding the randomised proof of knowledge. The issuer
 * stores this next to the nullifier: the same holder secret re-enrolling gives the same value.
 */
export function commitmentHash(commitment: Base64): string {
  return bytesToHex(sha256(parseRequest(commitment).c));
}

/** The current epoch, "YYYY-MM" in UTC. */
export function currentEpoch(now: Date = new Date()): Epoch {
  return now.toISOString().slice(0, 7);
}
