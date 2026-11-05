import "server-only";
// The spent-today ledger on the payer laptop (the payer's own data, not a backend). Atomic write via rename.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dayKey, emptyLedger, type Ledger } from "../policy.js";

export async function readLedger(path: string, now = new Date()): Promise<Ledger> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Ledger;
    if (raw?.v !== 1 || typeof raw.day !== "string" || typeof raw.spent !== "object" || !Array.isArray(raw.payments)) {
      throw new Error(`ledger at ${path} is malformed; refusing to guess`);
    }
    return raw;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger(dayKey(now));
    throw e;
  }
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2));
  await rename(tmp, path);
}
