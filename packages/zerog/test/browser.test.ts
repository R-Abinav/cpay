import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { encryptEpisode as browserEncrypt, parseEpisodeEnvelope, type Episode } from "../src/browser.js";
import { decryptEpisode, uploadEpisode, type Evidence } from "../src/index.js";

const episode: Episode = {
  decision: "paid",
  requestIds: ["req_a"],
  receipts: [],
  txHash: "0xpay",
  timestamps: {},
  policyResult: null,
};

describe("@cpay/zerog/browser", () => {
  it("has no node: imports or Buffer (browser-safe)", async () => {
    const src = await readFile(new URL("../src/browser.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "node:|require\(|Buffer\./);
  });

  it("browser ciphertext decrypts with the server-side helper and is a valid envelope", async () => {
    const key = new Uint8Array(randomBytes(32));
    const blob = await browserEncrypt(episode, key);
    expect(parseEpisodeEnvelope(blob)).not.toBeNull();
    expect(new TextDecoder().decode(blob)).not.toMatch(/0xpay|paid/);
    expect(await decryptEpisode(blob, key)).toEqual(episode);
  });

  it("accepts a non-extractable CryptoKey", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    expect(await decryptEpisode(await browserEncrypt(episode, key), key)).toEqual(episode);
  });

  it("parseEpisodeEnvelope rejects plaintext and extra fields", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(parseEpisodeEnvelope(enc(episode))).toBeNull();
    expect(parseEpisodeEnvelope(enc({ v: 1, alg: "AES-256-GCM", iv: "AAAAAAAAAAAAAAAA", ct: "A".repeat(24), decision: "paid" }))).toBeNull();
    expect(parseEpisodeEnvelope(enc({ v: 1, alg: "AES-256-GCM", iv: "AAAA", ct: "A".repeat(24) }))).toBeNull();
    expect(parseEpisodeEnvelope(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe("uploadEpisode (ciphertext only)", () => {
  const opts = (sink: Evidence[]) => ({
    rpcUrl: "http://unused",
    indexerUrl: "http://unused",
    privateKey: "0x" + "11".repeat(32),
    onEvidence: (ev: Evidence) => {
      sink.push(ev);
    },
  });

  it("refuses a plaintext episode before uploading", async () => {
    const sink: Evidence[] = [];
    let called = false;
    const plaintext = new TextEncoder().encode(JSON.stringify(episode));
    await expect(
      uploadEpisode(plaintext, [], opts(sink), async () => {
        called = true;
        return { rootHash: "0x", txHash: "0x" };
      }),
    ).rejects.toThrow(/not an encrypted episode envelope/);
    expect(called).toBe(false);
  });

  it("uploads the exact ciphertext and emits one storage evidence record", async () => {
    const sink: Evidence[] = [];
    const blob = await browserEncrypt(episode, new Uint8Array(randomBytes(32)));
    let uploaded: Uint8Array | undefined;
    // test-only uploader stand-in; the default is the real SDK upload
    const r = await uploadEpisode(blob, ["req_a", "req_b"], opts(sink), async (data) => {
      uploaded = data;
      return { rootHash: "0xroot", txHash: "0xtx" };
    });
    expect(uploaded).toBe(blob);
    expect(r).toMatchObject({ rootHash: "0xroot", txHash: "0xtx" });
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ kind: "storage", rootHash: "0xroot", requestIds: ["req_a", "req_b"] });
  });
});
