// @cpay/zerog/browser: browser-safe episode encryption (WebCrypto only; no node: imports, no Buffer, no keys
// of ours). The phone encrypts the episode with ITS episode key and sends only the ciphertext envelope to
// /api/episode, which uploads it to 0G Storage. The server never sees the plaintext or the key.

export interface Episode {
  decision: string;
  requestIds: string[];
  receipts: unknown[];
  txHash: string | null;
  timestamps: Record<string, string>;
  policyResult: unknown;
}

/** Encrypted envelope as stored on 0G Storage (UTF-8 JSON). */
export interface EpisodeEnvelope {
  v: 1;
  alg: "AES-256-GCM";
  /** base64, 12 bytes */
  iv: string;
  /** base64 ciphertext || 16-byte tag */
  ct: string;
}

const AAD = new TextEncoder().encode("cpay-episode-v1");

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is unavailable: needs a secure context (HTTPS)");
  return s;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `key`: the 32-byte episode key (derived on the phone) or a non-extractable AES-GCM CryptoKey. */
async function importKey(key: Uint8Array | CryptoKey, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array)) return key;
  if (key.length !== 32) throw new Error("episode key must be 32 bytes (AES-256)");
  return subtle().importKey("raw", new Uint8Array(key), "AES-GCM", false, [usage]);
}

/** AES-256-GCM encrypt -> UTF-8 JSON envelope bytes (what /api/episode accepts and 0G Storage holds). */
export async function encryptEpisode(episode: Episode, key: Uint8Array | CryptoKey): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(episode));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await importKey(key, "encrypt"), pt));
  const env: EpisodeEnvelope = { v: 1, alg: "AES-256-GCM", iv: toB64(iv), ct: toB64(ct) };
  return new TextEncoder().encode(JSON.stringify(env));
}

export async function decryptEpisode(blob: Uint8Array, key: Uint8Array | CryptoKey): Promise<Episode> {
  const env = parseEpisodeEnvelope(blob);
  if (!env) throw new Error("unknown episode envelope");
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: new Uint8Array(fromB64(env.iv)), additionalData: AAD },
    await importKey(key, "decrypt"),
    new Uint8Array(fromB64(env.ct)),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Episode;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Structural check that `blob` is exactly an encrypted envelope (and so not a plaintext episode):
 * a JSON object with only {v:1, alg, iv (12 bytes), ct (>= 16-byte tag)}. Returns null otherwise.
 */
export function parseEpisodeEnvelope(blob: Uint8Array): EpisodeEnvelope | null {
  let o: unknown;
  try {
    o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob));
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const e = o as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "alg,ct,iv,v" || e.v !== 1 || e.alg !== "AES-256-GCM") return null;
  if (typeof e.iv !== "string" || typeof e.ct !== "string" || !B64_RE.test(e.iv) || !B64_RE.test(e.ct)) return null;
  try {
    if (fromB64(e.iv).length !== 12 || fromB64(e.ct).length < 16) return null;
  } catch {
    return null;
  }
  return { v: 1, alg: "AES-256-GCM", iv: e.iv, ct: e.ct };
}
