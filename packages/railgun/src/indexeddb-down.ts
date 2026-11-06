/// <reference path="./declarations.d.ts" />
// A small IndexedDB-backed AbstractLevelDOWN store for the Railgun engine. The engine keeps
// encrypted wallet/scan state here; this adapter never writes the mnemonic or unencrypted keys.
import { AbstractIterator, AbstractLevelDOWN } from "abstract-leveldown";
import { Buffer } from "buffer";

type Row = { key: string; value: ArrayBuffer };
type Callback = (error?: Error | null, key?: unknown, value?: unknown) => void;

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("Railgun database value is not binary");
}

function asBuffer(value: ArrayBuffer | Uint8Array): Buffer {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export class IndexedDBDown extends AbstractLevelDOWN {
  private idb: IDBDatabase | null = null;

  constructor(private readonly name: string) {
    super({})
  }

  _open(_options: unknown, callback: (error?: Error | null) => void) {
    const request = indexedDB.open(this.name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
    };
    request.onsuccess = () => { this.idb = request.result; callback(); };
    request.onerror = () => callback(request.error ?? new Error("Could not open Railgun IndexedDB"));
  }

  _close(callback: (error?: Error | null) => void) {
    this.idb?.close();
    this.idb = null;
    callback();
  }

  _get(key: string, options: { asBuffer?: boolean }, callback: (error?: Error | null, value?: unknown) => void) {
    const db = this.idb;
    if (!db) return callback(new Error("Railgun IndexedDB is closed"));
    const request = db.transaction("records", "readonly").objectStore("records").get(key);
    request.onsuccess = () => {
      const row = request.result as Row | undefined;
      if (!row) {
        const error = new Error("NotFound") as Error & { notFound?: boolean; status?: number };
        error.notFound = true;
        error.status = 404;
        callback(error);
      } else callback(null, options.asBuffer === false ? new TextDecoder().decode(row.value) : asBuffer(row.value));
    };
    request.onerror = () => callback(request.error ?? new Error("Railgun IndexedDB read failed"));
  }

  _put(key: string, value: unknown, _options: unknown, callback: (error?: Error | null) => void) {
    const db = this.idb;
    if (!db) return callback(new Error("Railgun IndexedDB is closed"));
    const bytes = asBytes(value);
    const stored = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const request = db.transaction("records", "readwrite").objectStore("records").put({ key, value: stored } satisfies Row);
    request.onsuccess = () => callback();
    request.onerror = () => callback(request.error ?? new Error("Railgun IndexedDB write failed"));
  }

  _del(key: string, _options: unknown, callback: (error?: Error | null) => void) {
    const db = this.idb;
    if (!db) return callback(new Error("Railgun IndexedDB is closed"));
    const request = db.transaction("records", "readwrite").objectStore("records").delete(key);
    request.onsuccess = () => callback();
    request.onerror = () => callback(request.error ?? new Error("Railgun IndexedDB delete failed"));
  }

  _batch(operations: Array<{ type: "put" | "del"; key: string; value?: unknown }>, _options: unknown, callback: (error?: Error | null) => void) {
    const db = this.idb;
    if (!db) return callback(new Error("Railgun IndexedDB is closed"));
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    for (const operation of operations) {
      if (operation.type === "del") store.delete(operation.key);
      else {
        const bytes = asBytes(operation.value);
        const value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        store.put({ key: operation.key, value } satisfies Row);
      }
    }
    tx.oncomplete = () => callback();
    tx.onerror = () => callback(tx.error ?? new Error("Railgun IndexedDB batch failed"));
    tx.onabort = () => callback(tx.error ?? new Error("Railgun IndexedDB batch aborted"));
  }

  _iterator(options: Record<string, unknown>): any {
    const db = this.idb;
    const direction = options.reverse ? "prev" : "next";
    const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : Infinity;
    const rowsPromise = db
      ? requestResult(db.transaction("records", "readonly").objectStore("records").getAll()) as Promise<Row[]>
      : Promise.reject(new Error("Railgun IndexedDB is closed"));
    class Iterator extends AbstractIterator {
      private rows: Row[] | null = null;
      private index = 0;
      private emitted = 0;
      constructor(store: IndexedDBDown, iteratorOptions: Record<string, unknown>) {
        super(store, iteratorOptions);
      }
      async _next(callback: Callback) {
        try {
          this.rows ??= await rowsPromise;
          if (options.reverse && this.index === 0) this.rows.reverse();
          while (this.index < this.rows.length && this.emitted < limit) {
            const row = this.rows[this.index++];
            if (!row) continue;
            const key = row.key;
            if (options.gt !== undefined && !(key > String(options.gt))) continue;
            if (options.gte !== undefined && !(key >= String(options.gte))) continue;
            if (options.lt !== undefined && !(key < String(options.lt))) continue;
            if (options.lte !== undefined && !(key <= String(options.lte))) continue;
            this.emitted += 1;
            callback(null, options.keyAsBuffer === false ? key : asBuffer(new TextEncoder().encode(key)), options.valueAsBuffer === false ? new TextDecoder().decode(row.value) : asBuffer(row.value));
            return;
          }
          callback();
        } catch (error) { callback(error as Error); }
      }
      _end(callback: Callback) { callback(); }
    }
    return new Iterator(this, options);
  }
}
