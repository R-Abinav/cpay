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
  };
}
