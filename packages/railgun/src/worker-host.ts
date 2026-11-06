// Worker side of the Railgun worker: runs the real Kohaku client (initRailgun) and serves its methods.
// Logs nothing. One client per worker (the artifact fetch wrapper and the WASM are per global scope).
import { errorText, isToWorker, type FromWorker, type Port, type ToWorker } from "./worker-protocol.js";
import type { RailgunClient, RailgunConfig, RailgunStorage } from "./types.js";

type Init = (cfg: RailgunConfig) => Promise<RailgunClient>;

/** Serve one Railgun client over `port` (the worker's global scope). `init` is injectable for tests. */
export function serveRailgun(port: Port, init: Init): void {
  let client: Promise<RailgunClient> | null = null;
  let nextStorageId = 1;
  const waiting = new Map<number, { ok: (v: string | null) => void; fail: (e: Error) => void }>();
  const send = (m: FromWorker) => port.postMessage(m);

  // Storage lives on the page (encrypted vault): ask for each read/write.
  const ask = (m: { op: "get"; key: string } | { op: "set"; key: string; value: string }) =>
    new Promise<string | null>((ok, fail) => {
      const id = nextStorageId++;
      waiting.set(id, { ok, fail });
      send({ t: "storage", id, ...m });
    });
  const storage: RailgunStorage = {
    get: (key) => ask({ op: "get", key }),
    set: async (key, value) => void (await ask({ op: "set", key, value })),
  };

  async function call(m: Extract<ToWorker, { t: "call" }>, c: RailgunClient): Promise<unknown> {
    const a = (m.arg ?? {}) as Record<string, unknown>;
    switch (m.method) {
      case "sync":
        return c.sync();
      case "balances":
        return c.balances();
      case "canPay":
        if (typeof a.amount !== "bigint") throw new Error("railgun: bad canPay arguments");
        return c.canPay({ amount: a.amount, gasDropWei: typeof a.gasDropWei === "bigint" ? a.gasDropWei : undefined });
      case "prepareShield":
        if ((a.token !== "USDC" && a.token !== "WETH") || typeof a.amount !== "bigint" || typeof a.from !== "string") {
          throw new Error("railgun: bad prepareShield arguments");
        }
        return c.prepareShield({ token: a.token, amount: a.amount, from: a.from as `0x${string}` });
      case "pay":
        if (typeof a.amount !== "bigint" || typeof a.to !== "string") throw new Error("railgun: bad pay arguments");
        return c.pay({
          amount: a.amount,
          to: a.to as `0x${string}`,
          gasDropWei: typeof a.gasDropWei === "bigint" ? a.gasDropWei : undefined,
          onStage: (stage) => send({ t: "stage", id: m.id, stage }),
        });
    }
  }

  port.addEventListener("message", (e) => {
    const m = e.data;
    if (!isToWorker(m)) return; // not ours: ignore
    if (m.t === "storage") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.ok) w.ok(m.value);
      else w.fail(new Error(m.error));
      return;
    }
    const reply = (p: Promise<unknown>) =>
      p.then(
        (value) => send({ t: "result", id: m.id, ok: true, value: value ?? null }),
        (err: unknown) => send({ t: "result", id: m.id, ok: false, error: errorText(err) }),
      );
    if (m.t === "init") {
      if (client) return void reply(Promise.reject(new Error("railgun: worker already initialised")));
      const p = init({ ...m.cfg, storage });
      client = p;
      p.catch(() => {
        if (client === p) client = null; // a failed init may be retried
      });
      return void reply(p.then((c) => ({ address: c.address() })));
    }
    if (!client) return void reply(Promise.reject(new Error("railgun: worker not initialised")));
    void reply(client.then((c) => call(m, c)));
  });
}
