import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { connectRailgun } from "../src/worker-client.js";
import { serveRailgun } from "../src/worker-host.js";
import { isFromWorker, isToWorker, type WorkerConfig } from "../src/worker-protocol.js";
import type { PrivateBalances, RailgunClient, RailgunConfig } from "../src/types.js";

const seed = new Uint8Array(32).fill(7);
const base: WorkerConfig = {
  seed,
  chainId: 11155111,
  rpcUrl: "https://rpc.example",
  usdc: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  weth: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
  artifactsBase: "/railgun-artifacts/",
  wasmUrl: "/railgun/kohaku_bg.wasm",
  bundlerUrl: "/api/bundler",
};

const open: MessagePort[] = [];
afterEach(() => open.splice(0).forEach((p) => p.close()));

/** A MessagePort as the Worker-like shape both sides use. */
function adapt(p: MessagePort) {
  open.push(p);
  return {
    postMessage: (m: unknown) => p.postMessage(m),
    addEventListener: (type: "message" | "error", fn: (e: { data?: unknown }) => void) => {
      if (type === "message") p.on("message", (data) => fn({ data }));
    },
    terminate: () => p.close(),
  };
}

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
}

const bal: PrivateBalances = { usdc: { valid: 1_000_000n, pending: 5n }, weth: { valid: 10n ** 16n, pending: 0n } };

function fakeInit(seen: { cfg?: RailgunConfig }) {
  return async (cfg: RailgunConfig): Promise<RailgunClient> => {
    seen.cfg = cfg;
    if (cfg.rpcUrl === "fail") throw new Error("railgun: RPC is chain 1, expected 11155111");
    return {
      address: () => "0zk1test",
      sync: async () => {
        // Kohaku reads and writes its scan state through storage during sync.
        const v = await cfg.storage.get("scan");
        await cfg.storage.set("scan", `${v ?? ""}+`);
      },
      balances: async () => bal,
      canPay: async ({ amount }) => (amount <= bal.usdc.valid ? { ok: true } : { ok: false, reason: "usdc" }),
      prepareShield: async ({ amount }) => [{ to: base.usdc, data: "0x", value: amount }],
      pay: async ({ amount, onStage }) => {
        if (amount === 13n) throw new Error("railgun: not enough spendable (POI-valid) private USDC");
        onStage?.("proving");
        onStage?.("submitting");
        onStage?.("confirming");
        return { txHash: `0x${"ab".repeat(32)}` };
      },
    };
  };
}

function pair(init = fakeInit({})) {
  const { port1, port2 } = new MessageChannel();
  serveRailgun(adapt(port1), init);
  return adapt(port2);
}

describe("worker protocol guards", () => {
  it("accepts well-formed messages", () => {
    expect(isToWorker({ t: "init", id: 1, cfg: base })).toBe(true);
    expect(isToWorker({ t: "call", id: 2, method: "pay", arg: { amount: 1n } })).toBe(true);
    expect(isToWorker({ t: "storage", id: 3, ok: true, value: null })).toBe(true);
    expect(isFromWorker({ t: "stage", id: 4, stage: "proving" })).toBe(true);
    expect(isFromWorker({ t: "storage", id: 5, op: "set", key: "k", value: "v" })).toBe(true);
    expect(isFromWorker({ t: "result", id: 6, ok: true, value: null })).toBe(true);
  });

  it("rejects unknown methods, bad seeds, storage functions and bad ids", () => {
    expect(isToWorker({ t: "call", id: 1, method: "exportKeys" })).toBe(false);
    expect(isToWorker({ t: "init", id: 1, cfg: { ...base, seed: new Uint8Array(31) } })).toBe(false);
    expect(isToWorker({ t: "init", id: 1, cfg: { ...base, storage: {} } })).toBe(false);
    expect(isToWorker({ t: "call", id: -1, method: "sync" })).toBe(false);
    expect(isToWorker({ t: "call", id: 1.5, method: "sync" })).toBe(false);
    expect(isFromWorker({ t: "stage", id: 1, stage: "done" })).toBe(false);
    expect(isFromWorker({ t: "storage", id: 1, op: "delete", key: "k" })).toBe(false);
    expect(isFromWorker({ t: "result", id: 1, ok: false })).toBe(false);
    expect(isFromWorker(null)).toBe(false);
    expect(isFromWorker("result")).toBe(false);
  });
});

describe("worker round trip", () => {
  it("initialises with a copy of the seed and no storage object", async () => {
    const seen: { cfg?: RailgunConfig } = {};
    const c = await connectRailgun(pair(fakeInit(seen)), { ...base, storage: memStorage() });
    expect(c.address()).toBe("0zk1test");
    expect(seen.cfg?.seed).toEqual(seed);
    expect(seen.cfg?.seed).not.toBe(seed);
    expect(seen.cfg?.rpcUrl).toBe(base.rpcUrl);
    c.close();
  });

  it("proxies storage to the page and keeps bigints exact", async () => {
    const s = memStorage({ scan: "a" });
    const c = await connectRailgun(pair(), { ...base, storage: s });
    await c.sync();
    await c.sync();
    expect(s.m.get("scan")).toBe("a++");
    expect(await c.balances()).toEqual(bal);
    expect(await c.canPay({ amount: 2_000_000n })).toEqual({ ok: false, reason: "usdc" });
    expect(await c.prepareShield({ token: "USDC", amount: 2n ** 70n, from: base.usdc })).toEqual([{ to: base.usdc, data: "0x", value: 2n ** 70n }]);
    c.close();
  });

  it("delivers pay stages in order, then the tx hash", async () => {
    const c = await connectRailgun(pair(), { ...base, storage: memStorage() });
    const stages: string[] = [];
    const r = await c.pay({ amount: 1n, to: base.usdc, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["proving", "submitting", "confirming"]);
    expect(r.txHash).toBe(`0x${"ab".repeat(32)}`);
    c.close();
  });

  it("returns errors as messages and keeps serving", async () => {
    const c = await connectRailgun(pair(), { ...base, storage: memStorage() });
    await expect(c.pay({ amount: 13n, to: base.usdc })).rejects.toThrow("not enough spendable");
    await expect(c.prepareShield({ token: "DAI" as "USDC", amount: 1n, from: base.usdc })).rejects.toThrow("bad prepareShield");
    expect(await c.balances()).toEqual(bal);
    c.close();
  });

  it("a failed init rejects and terminates the worker", async () => {
    let terminated = false;
    const port = pair();
    await expect(connectRailgun({ ...port, terminate: () => (terminated = true) }, { ...base, rpcUrl: "fail", storage: memStorage() })).rejects.toThrow("RPC is chain 1");
    expect(terminated).toBe(true);
  });

  it("close rejects later calls", async () => {
    const c = await connectRailgun(pair(), { ...base, storage: memStorage() });
    c.close();
    await expect(c.balances()).rejects.toThrow("worker closed");
  });

  it("a worker error fails pending calls instead of hanging", async () => {
    const { port1, port2 } = new MessageChannel();
    open.push(port1, port2);
    let onError: (() => void) | undefined;
    const port = {
      postMessage: (m: unknown) => port2.postMessage(m),
      addEventListener: (type: "message" | "error", fn: (e: { data?: unknown }) => void) => {
        if (type === "error") onError = () => fn({});
        else port2.on("message", (data) => fn({ data }));
      },
    };
    const p = connectRailgun(port, { ...base, storage: memStorage() }); // nobody serves port1
    onError?.();
    await expect(p).rejects.toThrow("worker failed");
  });

  it("rejects calls before init", async () => {
    const { port1, port2 } = new MessageChannel();
    serveRailgun(adapt(port1), fakeInit({}));
    const p2 = adapt(port2);
    const reply = new Promise((ok) => p2.addEventListener("message", (e) => ok(e.data)));
    p2.postMessage({ t: "call", id: 9, method: "balances" });
    expect(await reply).toEqual({ t: "result", id: 9, ok: false, error: "railgun: worker not initialised" });
  });
});
