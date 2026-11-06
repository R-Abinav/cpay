// Message protocol between the page and the dedicated Railgun Web Worker (same origin, never the network).
// Kohaku's sync and Groth16 proving are long synchronous WASM runs; in a worker they never freeze the page.
// The seed goes in once, inside the "init" message, and lives only in the worker's memory (dropped when the
// page terminates the worker on lock). Storage stays on the page: the worker asks for every get/set, so the
// encrypted vault is unchanged. Every message is checked by the guards below before use.
import type { RailgunConfig } from "./types.js";

export type PayStage = "proving" | "submitting" | "confirming";
/** RailgunClient methods the worker serves (address() is answered from the init result). */
export const METHODS = ["sync", "balances", "canPay", "prepareShield", "pay"] as const;
export type Method = (typeof METHODS)[number];

/** RailgunConfig without storage (a function cannot cross postMessage; storage is proxied instead). */
export type WorkerConfig = Omit<RailgunConfig, "storage">;

export type ToWorker =
  | { t: "init"; id: number; cfg: WorkerConfig }
  | { t: "call"; id: number; method: Method; arg?: unknown }
  | { t: "storage"; id: number; ok: true; value: string | null }
  | { t: "storage"; id: number; ok: false; error: string };

export type FromWorker =
  | { t: "result"; id: number; ok: true; value: unknown }
  | { t: "result"; id: number; ok: false; error: string }
  | { t: "stage"; id: number; stage: PayStage }
  | { t: "storage"; id: number; op: "get"; key: string }
  | { t: "storage"; id: number; op: "set"; key: string; value: string };

/** The part of a Worker / DedicatedWorkerGlobalScope / MessagePort we use. */
export interface Port {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: { data?: unknown }) => void): void;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const str = (v: unknown): v is string => typeof v === "string";
const STAGES: readonly string[] = ["proving", "submitting", "confirming"];

function workerConfig(v: unknown): v is WorkerConfig {
  if (!obj(v)) return false;
  return (
    v.seed instanceof Uint8Array &&
    v.seed.length === 32 &&
    Number.isSafeInteger(v.chainId) &&
    str(v.rpcUrl) &&
    str(v.usdc) &&
    str(v.weth) &&
    str(v.artifactsBase) &&
    str(v.wasmUrl) &&
    str(v.bundlerUrl) &&
    !("storage" in v)
  );
}

export function isToWorker(v: unknown): v is ToWorker {
  if (!obj(v) || !id(v.id)) return false;
  switch (v.t) {
    case "init":
      return workerConfig(v.cfg);
    case "call":
      return str(v.method) && (METHODS as readonly string[]).includes(v.method);
    case "storage":
      return v.ok === true ? v.value === null || str(v.value) : v.ok === false && str(v.error);
    default:
      return false;
  }
}

export function isFromWorker(v: unknown): v is FromWorker {
  if (!obj(v) || !id(v.id)) return false;
  switch (v.t) {
    case "result":
      return v.ok === true ? "value" in v : v.ok === false && str(v.error);
    case "stage":
      return str(v.stage) && STAGES.includes(v.stage);
    case "storage":
      return v.op === "get" ? str(v.key) : v.op === "set" && str(v.key) && str(v.value);
    default:
      return false;
  }
}

/** Errors cross as their message only (never a stack, never an object that could carry state). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
