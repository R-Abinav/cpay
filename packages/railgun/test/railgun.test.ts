import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ARTIFACT_FILES, ARTIFACT_VARIANTS, KOHAKU_ARTIFACT_PREFIX, rewriteArtifactUrl } from "../src/artifacts.js";
import { dedupeNotes, fromHex, hexOf, rewindTail, storageKey } from "../src/tail.js";

const BASE = "https://cpay.example/railgun-artifacts/";

describe("self-hosted artifacts", () => {
  it("rewrites Kohaku's GitHub artifact URLs to our origin", () => {
    expect(rewriteArtifactUrl(`${KOHAKU_ARTIFACT_PREFIX}railgun/01x02/wasm.br`, BASE)).toBe(
      "https://cpay.example/railgun-artifacts/railgun/01x02/wasm.br",
    );
    expect(rewriteArtifactUrl(`${KOHAKU_ARTIFACT_PREFIX}railgun/poi/03x03/proving_key.bin.br`, BASE)).toBe(
      "https://cpay.example/railgun-artifacts/railgun/poi/03x03/proving_key.bin.br",
    );
  });

  it("leaves every other URL alone", () => {
    expect(rewriteArtifactUrl("https://ppoi.fdi.network/", BASE)).toBeNull();
    expect(rewriteArtifactUrl("https://github.com/other/repo/raw/main/x", BASE)).toBeNull();
  });

  it("rejects path tricks", () => {
    expect(() => rewriteArtifactUrl(`${KOHAKU_ARTIFACT_PREFIX}../../etc/passwd`, BASE)).toThrow();
    expect(() => rewriteArtifactUrl(`${KOHAKU_ARTIFACT_PREFIX}railgun/%2e%2e/%2e%2e/x`, BASE)).toThrow();
    expect(() => rewriteArtifactUrl(`${KOHAKU_ARTIFACT_PREFIX}railgun/01x02%2Fwasm.br`, BASE)).toThrow();
    expect(() => rewriteArtifactUrl(`${KOHAKU_ARTIFACT_PREFIX}railgun/01x02/wasm.br?x=1`, BASE)).toThrow();
  });

  it("the pinned manifest covers every variant the WASM can ask for", () => {
    const manifest = JSON.parse(readFileSync(new URL("../scripts/artifacts.manifest.json", import.meta.url), "utf8")) as Record<string, [string, number]>;
    for (const v of ARTIFACT_VARIANTS) for (const f of ARTIFACT_FILES) expect(manifest[`${v}/${f}`]?.[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(manifest)).toHaveLength(ARTIFACT_VARIANTS.length * ARTIFACT_FILES.length);
  });
});

describe("tail rescan", () => {
  const doc = (block: number) => hexOf(JSON.stringify({ v: 1, data: { synced_block: block, trees: [0] } }));
  const read = (v: string) => JSON.parse(Buffer.from(v, "hex").toString()).data.synced_block as number;

  it("moves the UTXO and account pointers back, never below the floor", async () => {
    const m = new Map<string, string>([
      [storageKey(11155111, "utxo_indexer"), doc(1000)],
      [storageKey(11155111, "account:0zk1abc"), doc(990)],
      [storageKey(11155111, "txid_indexer"), doc(900)],
    ]);
    const kv = { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
    await rewindTail(kv, 11155111, "0zk1abc", 50, 960);
    expect(read(m.get(storageKey(11155111, "utxo_indexer"))!)).toBe(960);
    expect(read(m.get(storageKey(11155111, "account:0zk1abc"))!)).toBe(960);
    expect(read(m.get(storageKey(11155111, "txid_indexer"))!)).toBe(900);
  });

  it("drops replayed duplicate notes losslessly (values above 2^53 survive)", async () => {
    const note = (leaf: number, value: string) =>
      `{"asset":{"type":"Erc20","value":"0xabc"},"leaf_index":${leaf},"memo":"a\\"}{","tree_number":0,"value":${value}}`;
    const text = `{"v":1,"data":{"notes":[${note(1, "123456789012345678901")},${note(2, "5")},${note(1, "123456789012345678901")}],"synced_block":77}}`;
    const key = storageKey(11155111, "account:0zk1abc");
    const m = new Map([[key, hexOf(text)]]);
    const kv = { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
    expect(await dedupeNotes(kv, 11155111, "0zk1abc")).toBe(true);
    const out = fromHex(m.get(key)!);
    expect(out).toBe(`{"v":1,"data":{"notes":[${note(1, "123456789012345678901")},${note(2, "5")}],"synced_block":77}}`);
    expect(await dedupeNotes(kv, 11155111, "0zk1abc")).toBe(false);
    await rewindTail(kv, 11155111, "0zk1abc", 50, 0);
    expect(fromHex(m.get(key)!)).toContain("123456789012345678901");
  });

  it("is a no-op on empty storage", async () => {
    const kv = { get: async () => null, set: async () => { throw new Error("must not write"); } };
    await expect(rewindTail(kv, 1, "0zk1x", 50, 0)).resolves.toBeUndefined();
  });

  it("uses Kohaku's key layout (chainId:hex(name))", () => {
    expect(storageKey(11155111, "utxo_indexer")).toBe("11155111:7574786f5f696e6465786572");
  });
});
