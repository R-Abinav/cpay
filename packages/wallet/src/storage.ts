// Tiny IndexedDB key-value store, on the device only. Values are structured-cloned, so a
// non-extractable CryptoKey can be stored without ever exposing its bytes.
const DB_NAME = "cpay-wallet";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function idb(): IDBFactory {
  const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new Error("wallet: IndexedDB is not available");
  return f;
}

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb().open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("wallet: IndexedDB open failed"));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error ?? new Error("wallet: IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("wallet: IndexedDB transaction aborted"));
      }),
  );
}

export function kvGet<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>("readonly", (s) => s.get(key));
}

export function kvSet(key: string, value: unknown): Promise<void> {
  return run<IDBValidKey>("readwrite", (s) => s.put(value, key)).then(() => undefined);
}

/** Every value whose key starts with `prefix`, in key order. */
export function kvList<T>(prefix: string): Promise<T[]> {
  return run<T[]>("readonly", (s) => s.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`)));
}

export function kvDelete(key: string): Promise<void> {
  return run<undefined>("readwrite", (s) => s.delete(key));
}

/** Tests only: close the handle so a fresh fake IndexedDB can be installed. */
export async function _resetStorageForTests(): Promise<void> {
  if (dbPromise) (await dbPromise.catch(() => null))?.close();
  dbPromise = null;
}
