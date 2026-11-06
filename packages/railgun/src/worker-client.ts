// Page side of the Railgun worker: the same RailgunClient interface, backed by messages to a dedicated
// worker that runs Kohaku. Answers the worker's storage reads/writes from `cfg.storage` (the page's vault).
// This module never imports Kohaku, so the page bundle stays free of the WASM.
import { errorText, isFromWorker, type Method, type PayStage, type WorkerConfig } from "./worker-protocol.js";
import type { RailgunClient, RailgunConfig } from "./types.js";

/** A Worker (or a MessagePort in tests). */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message" | "error", fn: (e: { data?: unknown }) => void): void;
  terminate?(): void;
}

export interface RailgunWorkerClient extends RailgunClient {
  /** Stop the worker (drops the seed and every key from its memory). Pending calls reject. */
  close(): void;
}

/** Connect to a worker that runs serveRailgun(). Resolves once the worker's client is initialised. */
export function connectRailgun(port: WorkerLike, cfg: RailgunConfig): Promise<RailgunWorkerClient> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; onStage?: (s: PayStage) => void }>();
  function shut(reason: string): void {
    if (closed) return;
    closed = true;
    port.terminate?.();
    for (const w of pending.values()) w.fail(new Error(reason));
    pending.clear();
  }
  // A worker that fails to load or throws at top level never answers: fail every call instead of hanging.
  port.addEventListener("error", () => shut("railgun: worker failed"));

  port.addEventListener("message", (e) => {
    const m = e.data;
    if (closed || !isFromWorker(m)) return;
    if (m.t === "storage") {
      const done = (r: { ok: true; value: string | null } | { ok: false; error: string }) => {
        if (!closed) port.postMessage({ t: "storage", id: m.id, ...r });
      };
      const p = m.op === "get" ? cfg.storage.get(m.key) : cfg.storage.set(m.key, m.value).then(() => null);
      p.then(
        (value) => done({ ok: true, value }),
        (err: unknown) => done({ ok: false, error: errorText(err) }),
      );
      return;
    }
    const w = pending.get(m.id);
    if (!w) return;
    if (m.t === "stage") return void w.onStage?.(m.stage);
    pending.delete(m.id);
    if (m.ok) w.ok(m.value);
    else w.fail(new Error(m.error));
  });

  function request<T>(msg: { t: "init"; cfg: WorkerConfig } | { t: "call"; method: Method; arg?: unknown }, onStage?: (s: PayStage) => void): Promise<T> {
    if (closed) return Promise.reject(new Error("railgun: worker closed"));
    const id = nextId++;
    return new Promise<T>((ok, fail) => {
      pending.set(id, { ok: ok as (v: unknown) => void, fail, onStage });
      port.postMessage({ ...msg, id });
    });
  }

  const { storage: _storage, ...rest } = cfg;
  const workerCfg: WorkerConfig = { ...rest, seed: cfg.seed.slice() };
  const init = request<{ address: string }>({ t: "init", cfg: workerCfg }).catch((e: unknown) => {
    shut("railgun: worker closed"); // never keep a worker holding the seed after a failed init
    throw e;
  });
  return init.then(({ address }) => ({
    address: () => address,
    sync: () => request<null>({ t: "call", method: "sync" }).then(() => undefined),
    balances: () => request({ t: "call", method: "balances" }),
    canPay: (arg) => request({ t: "call", method: "canPay", arg }),
    prepareShield: (arg) => request({ t: "call", method: "prepareShield", arg }),
    pay: ({ onStage, ...arg }) => request({ t: "call", method: "pay", arg }, onStage),
    close: () => shut("railgun: worker closed"),
  }));
}
