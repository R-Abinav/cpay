"use client";
// On-device vault for the recipient phone: face template, BBS card + holder secret, stealth keys,
// handed-out destinations. IndexedDB, every value AES-256-GCM encrypted with a NON-extractable WebCrypto key
// that is itself kept in IndexedDB (the key object can be used but never read out by script).
// Nothing here is ever uploaded.

const DB = "cpay";
const STORE = "vault";
const KEY_ID = "__aes_key";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        t.oncomplete = () => d.close();
      }),
  );
}

let keyPromise: Promise<CryptoKey> | null = null;
function vaultKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const existing = await tx<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID) as IDBRequest<CryptoKey | undefined>);
    if (existing) return existing;
    const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await tx("readwrite", (s) => s.put(k, KEY_ID));
    return k;
  })();
  return keyPromise;
}

interface Sealed {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export async function vaultSet(name: string, value: unknown): Promise<void> {
  const key = await vaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, key, pt);
  await tx("readwrite", (s) => s.put({ iv, ct } satisfies Sealed, name));
}

export async function vaultGet<T>(name: string): Promise<T | null> {
  const sealed = await tx<Sealed | undefined>("readonly", (s) => s.get(name) as IDBRequest<Sealed | undefined>);
  if (!sealed) return null;
  const key = await vaultKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode(name) },
    key,
    sealed.ct,
  );
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export async function vaultDelete(name: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(name));
}

/** Wipe everything, including the vault key. */
export async function vaultWipe(): Promise<void> {
  keyPromise = null;
  await tx("readwrite", (s) => s.clear());
}

export const VAULT = {
  stealthKeys: "stealthKeys",
  template: "faceTemplate",
  card: "card",
  pendingCommitment: "pendingCommitment",
  destinations: "destinations",
  invisible: "invisible",
  /** hex sha256(World sub) from Agent Pass "link" (Settings). Approvals must carry the same hash. */
  worldSubHash: "worldSubHash",
} as const;
