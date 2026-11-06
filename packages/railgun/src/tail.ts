// Tail rescan. Kohaku keeps its indexer state in memory once built and persists it to storage. Its
// Subsquid syncer can report a tip it has not fully indexed yet, and the "synced to" pointer then
// moves past events it never saw (seen in the spike). Before (re)building the provider we move the
// stored pointers back by `blocks`, so the syncers fetch that window again.
//
// Replaying the window re-adds every still-unspent note created in it (railgun-rs does not dedupe;
// seen on Sepolia: balances doubled). Spends replay as no-ops, so the duplicates are exactly the notes
// with the same (tree, leaf): `dedupeNotes` removes them and the caller rebuilds from storage.
//
// Storage layout (Kohaku DatabaseAdapter + railgun-rs): key = `${chainId}:${hex(name)}`,
// value = hex(JSON {v, data}). Names: "utxo_indexer", "account:<0zk…>", "txid_indexer", …
// Values hold integers above 2^53 (note values in wei), so we never JSON.parse + stringify them:
// every edit below is a lossless text edit.

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function hexOf(s: string): string {
  return Array.from(enc.encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): string {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new Error("railgun: bad stored value");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return dec.decode(out);
}

export function storageKey(chainId: number, name: string): string {
  return `${chainId}:${hexOf(name)}`;
}

const SYNCED = /"synced_block"\s*:\s*(\d+)/g;

/** Moves every `synced_block` in one stored doc back by `blocks` (never below `floor`). */
async function rewind(kv: KV, key: string, blocks: number, floor: number): Promise<void> {
  const raw = await kv.get(key);
  if (!raw) return;
  const text = fromHex(raw);
  const next = text.replace(SYNCED, (_m, n: string) => `"synced_block":${Math.max(floor, Number(n) - blocks)}`);
  if (next !== text) await kv.set(key, hexOf(next));
}

/** Rewinds the UTXO indexer and this account's scan pointer. */
export async function rewindTail(kv: KV, chainId: number, account: string, blocks: number, floor: number): Promise<void> {
  await rewind(kv, storageKey(chainId, "utxo_indexer"), blocks, floor);
  await rewind(kv, storageKey(chainId, `account:${account}`), blocks, floor);
}

/** Splits the top-level objects of the JSON array starting at text[open] === "[". */
function arrayObjects(text: string, open: number): { items: string[]; close: number } {
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      if (depth === 0) return { items, close: i };
      depth--;
      if (depth === 0) items.push(text.slice(start, i + 1));
    }
  }
  throw new Error("railgun: unterminated notes array");
}

function field(obj: string, name: string): string | null {
  return obj.match(new RegExp(`"${name}"\\s*:\\s*(\\d+)`))?.[1] ?? null;
}

/** Removes duplicate (tree, leaf) notes from this account's stored doc. True if any were removed. */
export async function dedupeNotes(kv: KV, chainId: number, account: string): Promise<boolean> {
  const key = storageKey(chainId, `account:${account}`);
  const raw = await kv.get(key);
  if (!raw) return false;
  const text = fromHex(raw);
  const m = /"notes"\s*:\s*\[/.exec(text);
  if (!m) return false;
  const open = m.index + m[0].length - 1;
  const { items, close } = arrayObjects(text, open);
  const seen = new Set<string>();
  const kept = items.filter((o) => {
    const id = `${field(o, "tree_number")}:${field(o, "leaf_index")}`;
    if (id.includes("null")) return true; // unknown shape: never drop
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (kept.length === items.length) return false;
  await kv.set(key, hexOf(`${text.slice(0, open + 1)}${kept.join(",")}${text.slice(close)}`));
  return true;
}
