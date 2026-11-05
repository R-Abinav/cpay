// Sealed boxes: X25519 -> HKDF-SHA256 (info "cpay/v1/<context>") -> AES-256-GCM (12-byte IV, AAD = context).
// Composition only; every primitive comes from @noble/*.
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Box } from "./messages.js";
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from "./encoding.js";

export const IV_LENGTH = 12;
export const KEY_LENGTH = 32;


export interface X25519KeyPair {
  secretKey: Uint8Array;
  /** lowercase hex, 32 bytes */
  publicKey: string;
}

/** Fresh X25519 key pair. Payers use one per session; recipients one per relay connection. */
export function generateKeyPair(): X25519KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey: bytesToHex(publicKey) };
}

export function publicKeyOf(secretKey: Uint8Array): string {
  return bytesToHex(x25519.getPublicKey(secretKey));
}

function deriveKey(secretKey: Uint8Array, peerPublicKey: string, context: string): Uint8Array {
  const pub = hexToBytes(peerPublicKey);
  if (pub.length !== 32) throw new Error("seal: peer public key must be 32 bytes");
  // getSharedSecret rejects low-order points (all-zero shared secret).
  const shared = x25519.getSharedSecret(secretKey, pub);
  return hkdf(sha256, shared, undefined, utf8ToBytes(`cpay/v1/${context}`), KEY_LENGTH);
}

function assertContext(context: string): void {
  if (context.length === 0) throw new Error("seal: empty context");
}

/** Seal bytes from `secretKey` to `peerPublicKey` (hex) under `context` (e.g. `probe:<sessionId>`). */
export function sealBytes(
  secretKey: Uint8Array,
  peerPublicKey: string,
  context: string,
  plaintext: Uint8Array,
): Box {
  assertContext(context);
  const key = deriveKey(secretKey, peerPublicKey, context);
  const iv = randomBytes(IV_LENGTH);
  const ct = gcm(key, iv, utf8ToBytes(context)).encrypt(plaintext);
  return { iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}

/** Open a box. Throws if the key, context or ciphertext is wrong. */
export function openBytes(
  secretKey: Uint8Array,
  peerPublicKey: string,
  context: string,
  box: Box,
): Uint8Array {
  assertContext(context);
  const iv = base64ToBytes(box.iv);
  if (iv.length !== IV_LENGTH) throw new Error("open: IV must be 12 bytes");
  const key = deriveKey(secretKey, peerPublicKey, context);
  return gcm(key, iv, utf8ToBytes(context)).decrypt(base64ToBytes(box.ct));
}

/** Seal a JSON-serialisable value. */
export function seal(secretKey: Uint8Array, peerPublicKey: string, context: string, value: unknown): Box {
  return sealBytes(secretKey, peerPublicKey, context, utf8ToBytes(JSON.stringify(value)));
}

/** Open a box and JSON-parse it. Callers must validate the result with zod. */
export function open(secretKey: Uint8Array, peerPublicKey: string, context: string, box: Box): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(openBytes(secretKey, peerPublicKey, context, box)));
}

export const probeContext = (sessionId: string): string => `probe:${sessionId}`;
export const claimContext = (sessionId: string): string => `claim:${sessionId}`;
