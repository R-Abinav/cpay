// Agent Pass approval tokens (docs/ARCHITECTURE.md "POLICY", "Implementation notes -> Wallet").
//
// Wire format: "<b64url(JSON payload)>.<b64url(Ed25519 signature)>", where the signature covers the
// UTF-8 bytes of "cpay/v1/approval." + <b64url(JSON payload)>.
// Payload: { v: 2, jti, bindingCommit, subHash, exp }
//   bindingCommit: hex sha256("cpay/v1/agent-pass-binding" || lp(salt) || lp(sessionId) || lp(amount)
//                  || lp(lowercase token) || lp(lowercase to)), lp(x) = 4-byte big-endian length || x.
//                  The binding {sessionId, amount, token, to} and its fresh 32-byte salt never leave the
//                  phone. The Agent Pass server only sees this commitment, so it can't link the World
//                  account (subHash) to a destination or an amount, even for the few minutes it holds it.
//     amount: USDC base units as a canonical decimal string ("2000000" = 2 USDC)
//     token:  token contract address; to: recipient address (both lowercased before hashing)
//   subHash: hex sha256(World `sub`), must equal the hash stored on the phone at "link" time
//   exp: unix seconds
// v1 tokens (which carried the plaintext binding) are rejected as malformed.
// The server (apps/web /api/agent-pass) signs with AGENT_PASS_APPROVAL_SECRET_KEY (our operational
// key, never a user's); the phone verifies with NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { kvGet, kvSet } from "./storage.js";

/** The payment an approval unlocks. Stays on the phone; only its salted commitment is sent. */
export interface ApprovalBinding {
  sessionId: string;
  amount: string;
  token: string;
  to: string;
}

export interface ApprovalPayload {
  v: 2;
  jti: string;
  /** hex approvalBindingCommit(binding, salt) */
  bindingCommit: string;
  subHash: string;
  exp: number;
}

export type ApprovalCheck =
  | { ok: true; payload: ApprovalPayload }
  | {
      ok: false;
      reason: "malformed" | "bad_signature" | "wrong_binding" | "wrong_sub" | "expired" | "reused" | "no_public_key" | "bad_salt";
    };

/** Where used jtis are remembered. Default: IndexedDB on this device. */
export interface JtiStore {
  has(jti: string): Promise<boolean>;
  add(jti: string, exp: number): Promise<void>;
}

const DOMAIN = "cpay/v1/approval.";
const COMMIT_DOMAIN = "cpay/v1/agent-pass-binding";
const K_JTI = "approval.usedJti";
const HEX64 = /^[0-9a-f]{64}$/;

function lp(bytes: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length, false);
  return concatBytes(len, bytes);
}

/** A fresh 32-byte salt for one approval. Kept on the phone only, next to the binding. */
export function newApprovalSalt(): Uint8Array {
  return randomBytes(32);
}

/**
 * The only thing about a payment the Agent Pass server sees: a salted hash of the binding.
 * Hex sha256("cpay/v1/agent-pass-binding" || lp(salt) || lp(sessionId) || lp(amount) || lp(token) || lp(to)),
 * token and to lowercased. Without the salt (on the phone only) the server can't test guesses of to/amount.
 */
export function approvalBindingCommit(binding: ApprovalBinding, salt: Uint8Array): string {
  if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new Error("wallet: approval salt must be 32 bytes");
  return bytesToHex(
    sha256(
      concatBytes(
        utf8ToBytes(COMMIT_DOMAIN),
        lp(salt),
        lp(utf8ToBytes(binding.sessionId)),
        lp(utf8ToBytes(binding.amount)),
        lp(utf8ToBytes(binding.token.toLowerCase())),
        lp(utf8ToBytes(binding.to.toLowerCase())),
      ),
    ),
  );
}

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function keyBytes(k: string | Uint8Array): Uint8Array {
  return typeof k === "string" ? hexToBytes(k.replace(/^0x/, "")) : k;
}

function isPayload(p: unknown): p is ApprovalPayload {
  const x = p as ApprovalPayload;
  return (
    !!x &&
    x.v === 2 &&
    typeof x.jti === "string" &&
    x.jti.length > 0 &&
    x.jti.length <= 128 &&
    typeof x.bindingCommit === "string" &&
    HEX64.test(x.bindingCommit) &&
    typeof x.subHash === "string" &&
    typeof x.exp === "number" &&
    Number.isFinite(x.exp)
  );
}

const idbJtiStore: JtiStore = {
  async has(jti) {
    const m = (await kvGet<Record<string, number>>(K_JTI)) ?? {};
    return Object.hasOwn(m, jti);
  },
  async add(jti, exp) {
    const m = (await kvGet<Record<string, number>>(K_JTI)) ?? {};
    const now = Math.floor(Date.now() / 1000);
    const kept: Record<string, number> = {};
    // Expired tokens fail the exp check anyway, so their jtis can be forgotten.
    for (const [k, e] of Object.entries(m)) if (e > now - 3600) kept[k] = e;
    kept[jti] = exp;
    await kvSet(K_JTI, kept);
  },
};

/** Server side (our approval key, never a user key): sign an approval payload. */
export function signApprovalToken(payload: ApprovalPayload, secretKey: string | Uint8Array): string {
  if (!isPayload(payload)) throw new Error("wallet: bad approval payload");
  const body = b64u(utf8ToBytes(JSON.stringify(payload)));
  const sig = ed25519.sign(utf8ToBytes(DOMAIN + body), keyBytes(secretKey));
  return `${body}.${b64u(sig)}`;
}

function envPublicKey(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY;
  } catch {
    return undefined;
  }
}

/**
 * Verify an approval token for exactly this payment: Ed25519 signature, v2, bindingCommit equal to
 * approvalBindingCommit(expected, salt) recomputed here, subHash == the linked World account, not expired,
 * jti unused. On success the jti is marked used, so the same token can never approve twice.
 */
export async function verifyApprovalToken(
  token: string,
  opts: {
    expected: ApprovalBinding;
    /** the 32-byte salt this phone generated for this approval (never sent anywhere) */
    salt: Uint8Array;
    subHash: string;
    publicKey?: string | Uint8Array;
    now?: number;
    jtiStore?: JtiStore;
  },
): Promise<ApprovalCheck> {
  const pkRaw = opts.publicKey ?? envPublicKey();
  if (!pkRaw) return { ok: false, reason: "no_public_key" };
  let pk: Uint8Array;
  try {
    pk = keyBytes(pkRaw);
  } catch {
    return { ok: false, reason: "no_public_key" };
  }
  if (pk.length !== 32) return { ok: false, reason: "no_public_key" };

  let expectedCommit: string;
  try {
    expectedCommit = approvalBindingCommit(opts.expected, opts.salt);
  } catch {
    return { ok: false, reason: "bad_salt" };
  }

  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body = "", sigPart = ""] = parts;
  const sig = unb64u(sigPart);
  const json = unb64u(body);
  if (!sig || !json || sig.length !== 64) return { ok: false, reason: "malformed" };

  let valid = false;
  try {
    valid = ed25519.verify(sig, utf8ToBytes(DOMAIN + body), pk, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPayload(payload)) return { ok: false, reason: "malformed" };

  if (payload.bindingCommit !== expectedCommit) return { ok: false, reason: "wrong_binding" };
  if (payload.subHash.toLowerCase() !== opts.subHash.toLowerCase()) return { ok: false, reason: "wrong_sub" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "expired" };

  const store = opts.jtiStore ?? idbJtiStore;
  if (await store.has(payload.jti)) return { ok: false, reason: "reused" };
  await store.add(payload.jti, payload.exp);
  return { ok: true, payload };
}

/** Hex helper for the approval key pair (tests, server setup). */
export function approvalPublicKey(secretKey: string | Uint8Array): string {
  return bytesToHex(ed25519.getPublicKey(keyBytes(secretKey)));
}
