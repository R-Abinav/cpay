import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZeroGUnavailable,
  computeRootHash,
  decryptEpisode,
  encryptEpisode,
  logEpisode,
  recoverSigner,
  type Episode,
  type StorageOptions,
} from "../src/index.js";

const episode: Episode = {
  decision: "paid",
  requestIds: ["req_stt", "req_intent", "req_tts"],
  receipts: [{ resKey: "chat-key-1", teeVerified: true }],
  txHash: "0xpaymenttx",
  timestamps: { capture: "2026-11-05T10:00:00Z", paid: "2026-11-05T10:00:09Z" },
  policyResult: { underCap: true },
};

afterEach(() => vi.restoreAllMocks());

describe("episode encryption", () => {
  it("round-trips with the right key and hides the plaintext", async () => {
    const key = new Uint8Array(randomBytes(32));
    const blob = await encryptEpisode(episode, key);
    expect(new TextDecoder().decode(blob)).not.toMatch(/req_intent|0xpaymenttx/);
    expect(await decryptEpisode(blob, key)).toEqual(episode);
  });

  it("fails with the wrong key and rejects short keys", async () => {
    const blob = await encryptEpisode(episode, new Uint8Array(randomBytes(32)));
    await expect(decryptEpisode(blob, new Uint8Array(randomBytes(32)))).rejects.toThrow();
    await expect(encryptEpisode(episode, new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });

  it("computes a deterministic 0G Storage merkle root offline (real SDK)", async () => {
    const data = new TextEncoder().encode("hello cpay");
    const root = await computeRootHash(data);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await computeRootHash(data)).toBe(root);
  });
});

describe("logEpisode", () => {
  const opts = async (): Promise<StorageOptions> => ({
    rpcUrl: "unused",
    indexerUrl: "unused",
    privateKey: "0x" + "11".repeat(32),
    evidencePath: join(await mkdtemp(join(tmpdir(), "zg-ep-")), "evidence.jsonl"),
  });

  it("uploads ciphertext and appends the plaintext index {rootHash, txHash, requestIds}", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const o = await opts();
    const key = new Uint8Array(randomBytes(32));
    let uploaded: Uint8Array | undefined;
    // test-only uploader stand-in; the default is the real SDK upload
    const r = await logEpisode(episode, key, o, async (data) => {
      uploaded = data;
      return { rootHash: "0xroot", txHash: "0xstoragetx" };
    });
    expect(r).toMatchObject({ rootHash: "0xroot", txHash: "0xstoragetx" });
    expect(await decryptEpisode(uploaded!, key)).toEqual(episode);
    const line = JSON.parse((await readFile(o.evidencePath, "utf8")).trim());
    expect(line).toMatchObject({ kind: "storage", rootHash: "0xroot", txHash: "0xstoragetx", requestIds: episode.requestIds });
    expect(JSON.stringify(line)).not.toMatch(/0xpaymenttx/);
  });

  it("throws ZeroGUnavailable with a storage evidence record when upload fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const o = await opts();
    const err = await logEpisode(episode, new Uint8Array(randomBytes(32)), o, async () => {
      throw new Error("indexer down");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZeroGUnavailable);
    expect((err as ZeroGUnavailable).evidence).toMatchObject({ kind: "storage", error: "storage_upload_failed" });
  });
});

describe("receipt signature recovery", () => {
  it("recovers the EIP-191 signer", async () => {
    const { Wallet } = await import("ethers");
    const w = Wallet.createRandom();
    const text = "zg-sig-v1/plain:0xaa:0xbb";
    expect(await recoverSigner(text, await w.signMessage(text))).toBe(w.address);
    expect(await recoverSigner(text, "0x1234")).toBeNull();
  });
});
