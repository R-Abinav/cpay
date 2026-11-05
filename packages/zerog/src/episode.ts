// Encrypted episode log on 0G Storage (Galileo testnet).
// The episode holds the decision, request IDs, receipts, the payment tx hash, timestamps and the policy
// result. No faces, no transcript, no recipient identity beyond the one-time destination.

import { webcrypto } from "node:crypto";
import { recordEvidence, type Evidence } from "./evidence.js";
import { ZeroGUnavailable } from "./router.js";

export interface Episode {
  decision: string;
  requestIds: string[];
  receipts: unknown[];
  txHash: string | null;
  timestamps: Record<string, string>;
  policyResult: unknown;
}

export interface StorageOptions {
  /** EVM RPC, e.g. https://evmrpc-testnet.0g.ai */
  rpcUrl: string;
  /** e.g. https://indexer-storage-testnet-turbo.0g.ai */
  indexerUrl: string;
  /** throwaway Galileo key that pays for uploads */
  privateKey: string;
  evidencePath: string;
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

async function importKey(key: Uint8Array, usage: "encrypt" | "decrypt") {
  if (key.length !== 32) throw new Error("episode key must be 32 bytes (AES-256)");
  return webcrypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [usage]);
}

export async function encryptEpisode(episode: Episode, key: Uint8Array): Promise<Uint8Array> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(episode));
  const ct = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await importKey(key, "encrypt"), pt),
  );
  const env: EpisodeEnvelope = {
    v: 1,
    alg: "AES-256-GCM",
    iv: Buffer.from(iv).toString("base64"),
    ct: Buffer.from(ct).toString("base64"),
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

export async function decryptEpisode(blob: Uint8Array, key: Uint8Array): Promise<Episode> {
  const env = JSON.parse(new TextDecoder().decode(blob)) as EpisodeEnvelope;
  if (env.v !== 1 || env.alg !== "AES-256-GCM") throw new Error("unknown episode envelope");
  const pt = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(env.iv, "base64"), additionalData: AAD },
    await importKey(key, "decrypt"),
    Buffer.from(env.ct, "base64"),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Episode;
}

/** 0G Storage merkle root of `data` (offline; the same value upload() commits to). */
export async function computeRootHash(data: Uint8Array): Promise<string> {
  const { MemData } = await import("@0gfoundation/0g-storage-ts-sdk");
  const [tree, err] = await new MemData(data).merkleTree();
  const root = tree?.rootHash();
  if (err || !root) throw new Error(`merkleTree failed: ${err?.message ?? "no root"}`);
  return root;
}

export type Uploader = (data: Uint8Array, opts: StorageOptions) => Promise<{ rootHash: string; txHash: string }>;

/** Real upload: @0gfoundation/0g-storage-ts-sdk + ethers v6. merkleTree() first, as the SDK requires. */
export const sdkUpload: Uploader = async (data, opts) => {
  const [{ MemData, Indexer }, { ethers }] = await Promise.all([
    import("@0gfoundation/0g-storage-ts-sdk"),
    import("ethers"),
  ]);
  const file = new MemData(data);
  const [tree, treeErr] = await file.merkleTree();
  const root = tree?.rootHash();
  if (treeErr || !root) throw new Error(`merkleTree failed: ${treeErr?.message ?? "no root"}`);
  const indexer = new Indexer(opts.indexerUrl);
  // The SDK's .d.ts resolve ethers' CJS types while we import its ESM types: same class at runtime.
  const signer = new ethers.Wallet(opts.privateKey, new ethers.JsonRpcProvider(opts.rpcUrl)) as unknown as Parameters<
    typeof indexer.upload
  >[2];
  const [tx, upErr] = await indexer.upload(file, opts.rpcUrl, signer);
  if (upErr) throw new Error(`0G Storage upload failed: ${upErr.message}`);
  if (!("txHash" in tx)) throw new Error("0G Storage upload was fragmented; episodes must be a single file");
  if (tx.rootHash.toLowerCase() !== root.toLowerCase()) throw new Error("0G Storage root hash mismatch with local merkleTree");
  return { rootHash: tx.rootHash, txHash: tx.txHash };
};

/**
 * AES-GCM encrypt the episode, upload it to 0G Storage, and append the plaintext index record
 * `{kind: "storage", rootHash, txHash, requestIds}` to the evidence JSONL.
 * Throws ZeroGUnavailable (with a storage evidence record) if the upload fails.
 */
export async function logEpisode(
  episode: Episode,
  episodeKey: Uint8Array,
  opts: StorageOptions,
  upload: Uploader = sdkUpload,
): Promise<{ rootHash: string; txHash: string; evidence: Evidence }> {
  const started = Date.now();
  const blob = await encryptEpisode(episode, episodeKey);
  const ev: Evidence = {
    ts: new Date().toISOString(),
    kind: "storage",
    model: "0g-storage",
    trustMode: "n/a",
    httpStatus: null,
    requestId: null,
    clientRequestId: null,
    receipt: null,
    rawTrace: null,
    rawZgHeaders: {},
    latencyMs: null,
    requestIds: [...episode.requestIds],
  };
  let out: { rootHash: string; txHash: string };
  try {
    out = await upload(blob, opts);
  } catch (err) {
    const failed = { ...ev, latencyMs: Date.now() - started, error: "storage_upload_failed" };
    await recordEvidence(failed, opts.evidencePath);
    throw new ZeroGUnavailable(`0G Storage: ${(err as Error).message}`, failed);
  }
  const done: Evidence = { ...ev, latencyMs: Date.now() - started, rootHash: out.rootHash, txHash: out.txHash };
  await recordEvidence(done, opts.evidencePath);
  return { rootHash: out.rootHash, txHash: out.txHash, evidence: done };
}

/** Storage options from ZG_STORAGE_* env vars (server-side only). */
export function storageOptionsFromEnv(env: Record<string, string | undefined> = process.env): StorageOptions {
  const privateKey = env.ZG_STORAGE_PRIVATE_KEY ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("ZG_STORAGE_PRIVATE_KEY is not set");
  return {
    rpcUrl: env.ZG_STORAGE_RPC_URL || "https://evmrpc-testnet.0g.ai",
    indexerUrl: env.ZG_STORAGE_INDEXER_URL || "https://indexer-storage-testnet-turbo.0g.ai",
    privateKey,
    evidencePath: env.ZG_EVIDENCE_PATH || "./data/zerog-evidence.jsonl",
  };
}
