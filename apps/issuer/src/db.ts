// The issuer's only table. One row per used (nullifier, action); nothing else, not even a timestamp
// (World's guide suggests `verified_at`; we omit it so rows can't be correlated with enrolment time).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface NullifierStore {
  /** Returns false if (nullifier, action) was already used. */
  insert(nullifier: string, action: string): boolean;
  close(): void;
}

export function openNullifierStore(path: string): NullifierStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS nullifiers (nullifier TEXT NOT NULL, action TEXT NOT NULL, UNIQUE (nullifier, action))",
  );
  const stmt = db.prepare("INSERT INTO nullifiers (nullifier, action) VALUES (?, ?)");
  return {
    insert(nullifier, action) {
      try {
        stmt.run(nullifier, action);
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return false;
        throw e;
      }
    },
    close() {
      db.close();
    },
  };
}

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * World nullifiers are 256-bit integers: 0x-hex (v3 responses) or decimal strings (v4 responses).
 * Store the normalised decimal so the same value in either spelling hits the UNIQUE constraint.
 */
export function normaliseNullifier(raw: string): string {
  let v: bigint;
  if (/^0x[0-9a-fA-F]{1,64}$/.test(raw)) v = BigInt(raw);
  else if (/^[0-9]{1,78}$/.test(raw)) v = BigInt(raw);
  else throw new Error("bad nullifier");
  if (v > UINT256_MAX) throw new Error("bad nullifier");
  return v.toString(10);
}
