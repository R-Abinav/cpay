// The issuer's only table: nullifiers(nullifier, action, commitment_hash), unique (nullifier, action).
// Nothing else, not even a timestamp (World's guide suggests `verified_at`; we omit it so rows can't be
// correlated with enrolment time). commitment_hash = sha256 of the BBS commitment C (not of the
// randomized proof of knowledge), so the same passkey re-enrolling on a new phone gets re-signed while
// a different holder secret for a used World ID is refused. Schema: apps/issuer/migrations/.

/** "new": first enrolment. "same": re-enrolment by the same holder (re-sign). "conflict": another holder (409). */
export type ClaimResult = "new" | "same" | "conflict";

export interface NullifierStore {
  readonly kind: "memory" | "postgres";
  claim(nullifier: string, action: string, commitmentHash: string): Promise<ClaimResult>;
  /** Cheap liveness check for GET /health. Throws if the database is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Tests and local dev without DATABASE_URL. Lost on restart, so never used in production (see main.ts). */
export class MemoryNullifierStore implements NullifierStore {
  readonly kind = "memory" as const;
  private readonly rows = new Map<string, string>();

  async claim(nullifier: string, action: string, commitmentHash: string): Promise<ClaimResult> {
    const key = JSON.stringify([nullifier, action]);
    const existing = this.rows.get(key);
    if (existing === undefined) {
      this.rows.set(key, commitmentHash);
      return "new";
    }
    return existing === commitmentHash ? "same" : "conflict";
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

/** The slice of the generated Prisma client the issuer uses (model `Nullifier` in packages/database). */
interface NullifierRow {
  nullifier: string;
  action: string;
  commitmentHash: string;
}
interface NullifierDelegate {
  createMany(args: { data: NullifierRow[]; skipDuplicates: boolean }): Promise<{ count: number }>;
  findUnique(args: {
    where: { nullifier_action_unique: { nullifier: string; action: string } };
    select: { commitmentHash: true };
  }): Promise<{ commitmentHash: string } | null>;
}
interface PrismaLike {
  nullifier: NullifierDelegate;
  $queryRawUnsafe(sql: string): Promise<unknown>;
  $disconnect(): Promise<void>;
}

/**
 * Supabase Postgres via Prisma from `@cpay/database` (same client as the hub and the web app).
 * Loaded lazily so tests never need a generated client. Errors surface as StoreError with a short code
 * only: raw driver errors can carry connection strings or row values and are never logged.
 */
export async function createPrismaNullifierStore(): Promise<NullifierStore> {
  const spec = "@cpay/database";
  const mod = (await import(spec)) as { prisma: PrismaLike };
  const prisma = mod.prisma;
  const wrap = async <T>(code: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      throw new StoreError(code);
    }
  };
  return {
    kind: "postgres",
    async claim(nullifier, action, commitmentHash) {
      // Insert-if-absent is atomic on the unique constraint, so two concurrent enrolments can't both win.
      const { count } = await wrap("db_insert", () =>
        prisma.nullifier.createMany({ data: [{ nullifier, action, commitmentHash }], skipDuplicates: true }),
      );
      if (count === 1) return "new";
      const row = await wrap("db_read", () =>
        prisma.nullifier.findUnique({
          where: { nullifier_action_unique: { nullifier, action } },
          select: { commitmentHash: true },
        }),
      );
      if (!row) throw new StoreError("db_inconsistent");
      return row.commitmentHash === commitmentHash ? "same" : "conflict";
    },
    async ping() {
      await wrap("db_ping", () => prisma.$queryRawUnsafe("select 1"));
    },
    async close() {
      await prisma.$disconnect().catch(() => undefined);
    },
  };
}

/** A database failure, carrying only a short code (never the driver's message). */
export class StoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StoreError";
  }
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
