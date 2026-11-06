/**
 * Glasses hub persistence. Stores ONLY `glasses_units(unit_id, unit_secret_hash, owner_token_hash)`
 * (CLAUDE.md invariant 3). No IPs, no timestamps of use, no frames, no OLED text.
 */

export interface UnitRecord {
  unitId: string;
  /** hex(sha256(unit_secret bytes)); also the device-auth HMAC key (see messages.ts). */
  unitSecretHash: string;
  /** hex(sha256(owner_token)) of the paired phone, or null when unpaired. */
  ownerTokenHash: string | null;
}

export interface UnitStore {
  readonly kind: "memory" | "postgres";
  getUnit(unitId: string): Promise<UnitRecord | null>;
  /** Trust on first use: creates the row if the unit is unknown. Returns false if it already existed. */
  registerUnit(unitId: string, unitSecretHash: string): Promise<boolean>;
  findByOwnerHash(ownerTokenHash: string): Promise<UnitRecord | null>;
  /** Sets (or clears with null) the owner of a unit. An owner hash is unique: any other unit holding it is cleared. */
  setOwner(unitId: string, ownerTokenHash: string | null): Promise<void>;
  close(): Promise<void>;
  /** Drop the database connection so the next call opens a fresh one (after a failure). Optional. */
  reset?(): Promise<void>;
}

/** In-memory store for tests and local dev without DATABASE_URL. Lost on restart. */
export class MemoryUnitStore implements UnitStore {
  readonly kind = "memory" as const;
  private readonly units = new Map<string, UnitRecord>();

  async getUnit(unitId: string): Promise<UnitRecord | null> {
    const u = this.units.get(unitId);
    return u ? { ...u } : null;
  }

  async registerUnit(unitId: string, unitSecretHash: string): Promise<boolean> {
    if (this.units.has(unitId)) return false;
    this.units.set(unitId, { unitId, unitSecretHash, ownerTokenHash: null });
    return true;
  }

  async findByOwnerHash(ownerTokenHash: string): Promise<UnitRecord | null> {
    for (const u of this.units.values()) if (u.ownerTokenHash === ownerTokenHash) return { ...u };
    return null;
  }

  async setOwner(unitId: string, ownerTokenHash: string | null): Promise<void> {
    if (ownerTokenHash !== null) {
      for (const u of this.units.values()) if (u.ownerTokenHash === ownerTokenHash) u.ownerTokenHash = null;
    }
    const u = this.units.get(unitId);
    if (u) u.ownerTokenHash = ownerTokenHash;
  }

  async close(): Promise<void> {}
}

/** The slice of the generated Prisma client the hub uses (model `GlassesUnit` in packages/database). */
interface GlassesUnitDelegate {
  findUnique(args: { where: { unitId: string } }): Promise<UnitRecord | null>;
  findFirst(args: { where: { ownerTokenHash: string } }): Promise<UnitRecord | null>;
  createMany(args: { data: { unitId: string; unitSecretHash: string }[]; skipDuplicates: boolean }): Promise<{ count: number }>;
  updateMany(args: { where: { ownerTokenHash?: string; unitId?: string }; data: { ownerTokenHash: string | null } }): Promise<{ count: number }>;
}
interface PrismaLike {
  glassesUnit: GlassesUnitDelegate;
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
}

const pick = (u: UnitRecord | null): UnitRecord | null =>
  u ? { unitId: u.unitId, unitSecretHash: u.unitSecretHash, ownerTokenHash: u.ownerTokenHash } : null;

/** Postgres (Supabase) via Prisma from `@cpay/database`. Loaded lazily so tests never need a generated client. */
export async function createPrismaUnitStore(): Promise<UnitStore> {
  const spec = "@cpay/database";
  const mod = (await import(spec)) as { prisma: PrismaLike };
  const prisma = mod.prisma;
  return {
    kind: "postgres",
    async getUnit(unitId) {
      return pick(await prisma.glassesUnit.findUnique({ where: { unitId } }));
    },
    async registerUnit(unitId, unitSecretHash) {
      const r = await prisma.glassesUnit.createMany({ data: [{ unitId, unitSecretHash }], skipDuplicates: true });
      return r.count === 1;
    },
    async findByOwnerHash(ownerTokenHash) {
      return pick(await prisma.glassesUnit.findFirst({ where: { ownerTokenHash } }));
    },
    async setOwner(unitId, ownerTokenHash) {
      await prisma.$transaction(async (tx) => {
        if (ownerTokenHash !== null) {
          await tx.glassesUnit.updateMany({ where: { ownerTokenHash }, data: { ownerTokenHash: null } });
        }
        await tx.glassesUnit.updateMany({ where: { unitId }, data: { ownerTokenHash } });
      });
    },
    async close() {
      await prisma.$disconnect();
    },
    // Prisma reconnects lazily on the next query; a pool left broken by a pooler outage otherwise keeps
    // failing with P1001 after the database is back (seen 6 Nov: only a hub restart cleared it).
    async reset() {
      await prisma.$disconnect();
    },
  };
}

/**
 * Wraps a store so a database blip (e.g. a flaky phone hotspot dropping the Supabase connection) doesn't
 * break glasses or phones that already authenticated: reads fall back to the last value seen, in memory.
 * Writes still go to the database first and fail loudly. Holds only what the table holds (hashes + ids).
 */
export function withReadCache(inner: UnitStore): UnitStore {
  const byId = new Map<string, UnitRecord>();
  const remember = (r: UnitRecord | null) => {
    if (r) byId.set(r.unitId, { ...r });
    return r;
  };
  const byOwner = (h: string) => [...byId.values()].find((r) => r.ownerTokenHash === h) ?? null;
  return {
    kind: inner.kind,
    async getUnit(unitId) {
      try {
        return remember(await inner.getUnit(unitId));
      } catch (e) {
        const hit = byId.get(unitId);
        if (hit) return { ...hit };
        throw e;
      }
    },
    async registerUnit(unitId, unitSecretHash) {
      const created = await inner.registerUnit(unitId, unitSecretHash);
      if (created) byId.set(unitId, { unitId, unitSecretHash, ownerTokenHash: null });
      return created;
    },
    async findByOwnerHash(h) {
      try {
        return remember(await inner.findByOwnerHash(h));
      } catch (e) {
        const hit = byOwner(h);
        if (hit) return { ...hit };
        throw e;
      }
    },
    async setOwner(unitId, ownerTokenHash) {
      await inner.setOwner(unitId, ownerTokenHash);
      for (const r of byId.values()) if (ownerTokenHash !== null && r.ownerTokenHash === ownerTokenHash) r.ownerTokenHash = null;
      const r = byId.get(unitId);
      if (r) r.ownerTokenHash = ownerTokenHash;
    },
    close: () => inner.close(),
  };
}

/**
 * The error's class name (and Prisma error code if any) for logs. Never the message: Prisma messages can
 * name the database host, and connection strings must never reach a log.
 */
export function errorClass(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code ?? (e as { errorCode?: unknown }).errorCode;
  const name = /^[A-Za-z0-9_]{1,64}$/.test(e.constructor.name) ? e.constructor.name : "Error";
  return typeof code === "string" && /^P\d{4}$/.test(code) ? `${name}:${code}` : name;
}

export interface RetryOptions {
  /** Delay before each retry; tries = delaysMs.length + 1. Default 300 ms, 1 s, 3 s (4 tries). */
  delaysMs?: number[];
  log?: (line: string) => void;
}

/**
 * Retries every store call on failure (a flaky hotspot drops the Supabase pooler for a moment). All calls are
 * idempotent: reads, `registerUnit` (insert-if-absent; a lost answer reads back false and the hub verifies the
 * stored hash) and `setOwner` (sets an absolute value). The last error is rethrown: callers fail loudly.
 */
export function withRetry(inner: UnitStore, o: RetryOptions = {}): UnitStore {
  const delays = o.delaysMs ?? [300, 1000, 3000];
  const log = o.log ?? ((l: string) => console.log(l));
  const run = async <T>(op: string, f: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return await f();
      } catch (e) {
        if (i >= delays.length) {
          log(`[hub] store ${op} failed tries=${i + 1} err=${errorClass(e)}`);
          throw e;
        }
        log(`[hub] store ${op} retry=${i + 1} err=${errorClass(e)}`);
        await inner.reset?.().catch(() => undefined); // fresh connection for the retry
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  };
  return {
    kind: inner.kind,
    getUnit: (id) => run("getUnit", () => inner.getUnit(id)),
    registerUnit: (id, h) => run("registerUnit", () => inner.registerUnit(id, h)),
    findByOwnerHash: (h) => run("findByOwnerHash", () => inner.findByOwnerHash(h)),
    setOwner: (id, h) => run("setOwner", () => inner.setOwner(id, h)),
    close: () => inner.close(),
    reset: inner.reset ? () => inner.reset!() : undefined,
  };
}
