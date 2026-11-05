// Encrypted episode log on 0G Storage (Galileo testnet).
// The episode holds the decision, request IDs, receipts, the payment tx hash, timestamps and the policy
// result. No faces, no transcript, no recipient identity beyond the one-time destination.

import { encryptEpisode, parseEpisodeEnvelope, type Episode } from "./browser.js";
import { recordEvidence, type Evidence } from "./evidence.js";
import { ZeroGUnavailable } from "./router.js";

export { decryptEpisode, encryptEpisode, parseEpisodeEnvelope, type Episode, type EpisodeEnvelope } from "./browser.js";

export interface StorageOptions {
  /** EVM RPC, e.g. https://evmrpc-testnet.0g.ai */
  rpcUrl: string;
  /** e.g. https://indexer-storage-testnet-turbo.0g.ai */
  indexerUrl: string;
  /** throwaway Galileo key that pays for uploads (ours, never a user's) */
  privateKey: string;
  /** JSONL path for the default evidence recorder (ignored when onEvidence is set) */
  evidencePath?: string;
  /** evidence sink (same contract as RouterClientOptions.onEvidence) */
  onEvidence?: (evidence: Evidence) => void | Promise<void>;
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

async function emit(ev: Evidence, opts: StorageOptions): Promise<void> {
  if (!opts.onEvidence) return recordEvidence(ev, opts.evidencePath);
  try {
    await opts.onEvidence(ev);
  } catch {
    console.error(`[0g] evidence sink FAILED kind=storage rootHash=${ev.rootHash ?? "missing"}`);
  }
}

/**
 * Upload an already-encrypted episode envelope (from encryptEpisode, done on the phone) to 0G Storage and
 * record the plaintext index `{kind: "storage", rootHash, txHash, requestIds}`. Refuses anything that is
 * not exactly an envelope, so a plaintext episode can never be uploaded by mistake.
 * Throws ZeroGUnavailable (with a storage evidence record) if the upload fails.
 */
export async function uploadEpisode(
  ciphertext: Uint8Array,
  requestIds: readonly string[],
  opts: StorageOptions,
  upload: Uploader = sdkUpload,
): Promise<{ rootHash: string; txHash: string; evidence: Evidence }> {
  if (!parseEpisodeEnvelope(ciphertext)) throw new Error("uploadEpisode: not an encrypted episode envelope");
  const started = Date.now();
  const blob = ciphertext;
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
    requestIds: [...requestIds],
  };
  let out: { rootHash: string; txHash: string };
  try {
    out = await upload(blob, opts);
  } catch (err) {
    const failed = { ...ev, latencyMs: Date.now() - started, error: "storage_upload_failed" };
    await emit(failed, opts);
    throw new ZeroGUnavailable(`0G Storage: ${(err as Error).message}`, failed);
  }
  const done: Evidence = { ...ev, latencyMs: Date.now() - started, rootHash: out.rootHash, txHash: out.txHash };
  await emit(done, opts);
  return { rootHash: out.rootHash, txHash: out.txHash, evidence: done };
}

/** Encrypt (same code the phone runs) + uploadEpisode. For the smoke script and tests. */
export async function logEpisode(
  episode: Episode,
  episodeKey: Uint8Array,
  opts: StorageOptions,
  upload: Uploader = sdkUpload,
): Promise<{ rootHash: string; txHash: string; evidence: Evidence }> {
  return uploadEpisode(await encryptEpisode(episode, episodeKey), episode.requestIds, opts, upload);
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
