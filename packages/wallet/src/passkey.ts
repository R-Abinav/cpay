// The one module that owns the root secret (docs/ARCHITECTURE.md onboarding step 2).
//
// passkey mode: root = WebAuthn PRF output for salt sha256("cpay/v1/root"). Never stored; the
//   passkey is asked again on every unlock. IndexedDB holds only the credential ID.
// local mode (no PRF): a random root, stored in IndexedDB encrypted under a non-extractable
//   AES-GCM CryptoKey. Losing the phone without exportBackup() loses the funds: the UI must say so.
//
// Session: unlocked keys live in memory only (lock() drops them).
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { deriveKeys, PRF_SALT, type WalletKeys } from "./keys.js";
import { kvDelete, kvGet, kvSet } from "./storage.js";

export interface WalletHandle {
  address: `0x${string}`;
  account: LocalAccount;
  keys: WalletKeys;
  mode: "passkey" | "local";
}

type Mode = WalletHandle["mode"];

interface LocalRootRecord {
  key: CryptoKey;
  iv: Uint8Array;
  ct: Uint8Array;
}

const K_MODE = "wallet.mode";
const K_CRED = "wallet.credentialId";
const K_LOCAL = "wallet.localRoot";

let session: WalletHandle | null = null;

// ---- helpers ----

function cryptoApi(): Crypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("wallet: WebCrypto is not available (needs a secure context)");
  return c;
}

function randomBytes(n: number): Uint8Array {
  return cryptoApi().getRandomValues(new Uint8Array(n));
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource typing). */
function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(u.length));
  out.set(u);
  return out;
}

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function handleFromRoot(root: Uint8Array, mode: Mode): WalletHandle {
  const keys = deriveKeys(root);
  root.fill(0);
  const account = privateKeyToAccount(keys.agentPrivateKey);
  session = { address: account.address, account, keys, mode };
  return session;
}

function webauthn(): CredentialsContainer {
  const c = (globalThis as { navigator?: Navigator }).navigator?.credentials;
  if (!c || typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential === "undefined") {
    throw new Error("wallet: WebAuthn is not available");
  }
  return c;
}

// ---- PRF ----

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };

function prfOutput(cred: PublicKeyCredential): Uint8Array | null {
  const ext = cred.getClientExtensionResults() as { prf?: PrfResults };
  const first = ext.prf?.results?.first;
  if (!first) return null;
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

async function prfRoot(rpId: string, credentialId: Uint8Array): Promise<Uint8Array | null> {
  const cred = (await webauthn().get({
    publicKey: {
      rpId,
      challenge: buf(randomBytes(32)),
      allowCredentials: [{ type: "public-key", id: buf(credentialId) }],
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: buf(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("wallet: passkey prompt was cancelled");
  return prfOutput(cred);
}

/**
 * Best-effort capability check. Uses PublicKeyCredential.getClientCapabilities() where present
 * ("extension:prf"); otherwise returns whether WebAuthn exists at all, and createWallet() still
 * falls back to local mode if the passkey turns out to have no PRF.
 */
export async function prfSupported(): Promise<boolean> {
  const PKC = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>> } })
    .PublicKeyCredential;
  if (!PKC || !(globalThis as { navigator?: Navigator }).navigator?.credentials) return false;
  if (typeof PKC.getClientCapabilities === "function") {
    try {
      const caps = await PKC.getClientCapabilities();
      if (typeof caps["extension:prf"] === "boolean") return caps["extension:prf"];
    } catch {
      // fall through
    }
  }
  return true;
}

// ---- local mode ----

async function newLocalRoot(): Promise<Uint8Array> {
  const root = randomBytes(32);
  const key = await cryptoApi().subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await storeLocalRoot(root, key);
  return root;
}

async function storeLocalRoot(root: Uint8Array, key: CryptoKey): Promise<void> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(new TextEncoder().encode("cpay/v1/local-root")) }, key, buf(root)),
  );
  const rec: LocalRootRecord = { key, iv, ct };
  await kvSet(K_LOCAL, rec);
  await kvDelete(K_CRED);
  await kvSet(K_MODE, "local");
}

async function loadLocalRoot(): Promise<Uint8Array> {
  const rec = await kvGet<LocalRootRecord>(K_LOCAL);
  if (!rec) throw new Error("wallet: no local wallet on this device");
  return new Uint8Array(
    await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: buf(rec.iv), additionalData: buf(new TextEncoder().encode("cpay/v1/local-root")) },
      rec.key,
      buf(rec.ct),
    ),
  );
}

// ---- API ----

export async function hasWallet(): Promise<boolean> {
  const mode = await kvGet<Mode>(K_MODE);
  return mode === "passkey" || mode === "local";
}

/** Which mode the stored wallet uses, or null. */
export async function walletMode(): Promise<Mode | null> {
  const mode = await kvGet<Mode>(K_MODE);
  return mode === "passkey" || mode === "local" ? mode : null;
}

/** The unlocked wallet of this page session, if any. */
export function currentWallet(): WalletHandle | null {
  return session;
}

/** Forget the in-memory keys. */
export function lock(): void {
  session = null;
}

/**
 * Create a passkey with PRF, then evaluate PRF once to get the root. If the browser or the
 * authenticator has no PRF, falls back to mode "local" (random root on this device only).
 */
export async function createWallet(opts: { rpId: string; userName?: string }): Promise<WalletHandle> {
  if (await prfSupported()) {
    const userName = opts.userName || "CPay wallet";
    const cred = (await webauthn().create({
      publicKey: {
        rp: { id: opts.rpId, name: "CPay" },
        // Random user handle: no account, no identity. Only this passkey knows it.
        user: { id: buf(randomBytes(16)), name: userName, displayName: userName },
        challenge: buf(randomBytes(32)),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: 120_000,
        attestation: "none",
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("wallet: passkey creation was cancelled");
    const ext = cred.getClientExtensionResults() as { prf?: PrfResults };
    if (ext.prf?.enabled !== false) {
      const credentialId = new Uint8Array(cred.rawId);
      const root = await prfRoot(opts.rpId, credentialId);
      if (root) {
        await kvSet(K_CRED, b64u(credentialId));
        await kvDelete(K_LOCAL);
        await kvSet(K_MODE, "passkey");
        return handleFromRoot(root, "passkey");
      }
    }
    // The passkey exists but has no PRF: it is unused from here on.
  }
  return handleFromRoot(await newLocalRoot(), "local");
}

/** Re-derive the same keys: passkey prompt with PRF (passkey mode) or decrypt the local root. */
export async function unlock(opts: { rpId: string }): Promise<WalletHandle> {
  const mode = await walletMode();
  if (mode === "local") return handleFromRoot(await loadLocalRoot(), "local");
  if (mode !== "passkey") throw new Error("wallet: no wallet on this device");
  const id = await kvGet<string>(K_CRED);
  if (!id) throw new Error("wallet: credential ID missing");
  const root = await prfRoot(opts.rpId, unb64u(id));
  if (!root) throw new Error("wallet: this passkey returned no PRF output");
  return handleFromRoot(root, "passkey");
}

/**
 * Restore a passkey wallet on this device after its local storage was lost (cleared site data, a new
 * browser or home-screen app on the same domain). Asks for any CPay passkey of this domain (discoverable,
 * no credential list), evaluates PRF with the same salt, so the SAME keys come back. Stores only the
 * credential ID, as createWallet does.
 */
export async function restoreWallet(opts: { rpId: string }): Promise<WalletHandle> {
  const cred = (await webauthn().get({
    publicKey: {
      rpId: opts.rpId,
      challenge: buf(randomBytes(32)),
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: buf(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("wallet: passkey prompt was cancelled");
  const root = prfOutput(cred);
  if (!root) throw new Error("wallet: this passkey returned no PRF output");
  await kvSet(K_CRED, b64u(new Uint8Array(cred.rawId)));
  await kvDelete(K_LOCAL);
  await kvSet(K_MODE, "passkey");
  return handleFromRoot(root, "passkey");
}

// ---- encrypted backup (local mode) ----

interface BackupV1 {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  ct: string;
}

const BACKUP_AAD = new TextEncoder().encode("cpay/v1/backup");
const SCRYPT = { N: 2 ** 16, r: 8, p: 1 };

async function backupKey(passphrase: string, salt: Uint8Array, params: { N: number; r: number; p: number }): Promise<CryptoKey> {
  const raw = await scryptAsync(passphrase.normalize("NFKC"), salt, { ...params, dkLen: 32 });
  const key = await cryptoApi().subtle.importKey("raw", buf(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

/** Local mode only: the root encrypted under a passphrase (scrypt -> AES-256-GCM), as a string. */
export async function exportBackup(passphrase: string, opts: { scryptN?: number } = {}): Promise<string> {
  if (passphrase.length < 8) throw new Error("wallet: passphrase must be at least 8 characters");
  if ((await walletMode()) !== "local") throw new Error("wallet: passkey wallets are backed up by the synced passkey");
  const params = { ...SCRYPT, N: opts.scryptN ?? SCRYPT.N };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const root = await loadLocalRoot();
  const key = await backupKey(passphrase, salt, params);
  const ct = new Uint8Array(await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(BACKUP_AAD) }, key, buf(root)));
  root.fill(0);
  const b: BackupV1 = { v: 1, kdf: "scrypt", ...params, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) };
  return JSON.stringify(b);
}

/** Restore a local-mode wallet from exportBackup() output. Replaces any wallet on this device. */
export async function importBackup(backup: string, passphrase: string): Promise<WalletHandle> {
  let b: BackupV1;
  try {
    b = JSON.parse(backup) as BackupV1;
  } catch {
    throw new Error("wallet: backup is not valid JSON");
  }
  if (b?.v !== 1 || b.kdf !== "scrypt" || ![b.N, b.r, b.p].every((x) => Number.isSafeInteger(x) && x > 0) || b.N > 2 ** 20) {
    throw new Error("wallet: unsupported backup format");
  }
  const key = await backupKey(passphrase, unb64u(b.salt), { N: b.N, r: b.r, p: b.p });
  let root: Uint8Array;
  try {
    root = new Uint8Array(
      await cryptoApi().subtle.decrypt({ name: "AES-GCM", iv: buf(unb64u(b.iv)), additionalData: buf(BACKUP_AAD) }, key, buf(unb64u(b.ct))),
    );
  } catch {
    throw new Error("wallet: wrong passphrase or corrupted backup");
  }
  if (root.length !== 32) throw new Error("wallet: corrupted backup");
  const deviceKey = await cryptoApi().subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await storeLocalRoot(root, deviceKey);
  return handleFromRoot(root, "local");
}

/** Remove the wallet from this device (credential ID or local root). Funds stay on chain. */
export async function forgetWallet(): Promise<void> {
  session = null;
  await kvDelete(K_LOCAL);
  await kvDelete(K_CRED);
  await kvDelete(K_MODE);
}
