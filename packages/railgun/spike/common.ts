// Shared helpers for the Railgun spike scripts. Never print secrets from here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as rg from "@kohaku-eth/railgun";

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

export async function initKohaku(level: rg.LogLevel = "Off"): Promise<void> {
  const lib = req.resolve("@kohaku-eth/railgun");
  const wasmPath = resolve(dirname(lib), "../pkg/index_bg.wasm");
  await rg.ensureInitialized(readFileSync(wasmPath), level);
}

/** Reads one key from apps/web/.env without printing it. */
export function readEnv(key: string): string | undefined {
  const envPath = resolve(here, "../../../apps/web/.env");
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

export const ms = (t0: number) => `${(performance.now() - t0).toFixed(0)} ms`;
