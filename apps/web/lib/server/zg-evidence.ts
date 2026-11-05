import "server-only";
// 0G evidence sink: every 0G call made by an API route logs ONE line and writes ONE row to Supabase
// (`zg_evidence`, Prisma model ZgEvidence in packages/database). IDs, receipt status, model names, hashes
// and the router trace only: never audio, transcript, prompt, completion text, addresses, IPs or tickets.
// Without DATABASE_URL it logs only (and says so once).
import type { Evidence } from "@cpay/zerog";

export type ReceiptStatus = "verified" | "unverified" | "missing" | "error";
export type RowStatus = "ok" | "refused" | "error";
export type RowKind = "stt" | "intent" | "tts" | "storage";

/** Exactly the columns of model ZgEvidence (minus id/createdAt). */
export interface EvidenceRow {
  kind: RowKind;
  model: string;
  trustMode: string;
  requestId: string | null;
  providerResponseKey: string | null;
  receiptSignature: string | null;
  receiptStatus: ReceiptStatus;
  teeVerified: boolean | null;
  status: RowStatus;
  latencyMs: number | null;
  rootHash: string | null;
  trace: Record<string, unknown>;
}

const KIND: Record<string, RowKind> = { transcribe: "stt", speak: "tts", intent: "intent", storage: "storage" };

/** verified: router checked the provider's TEE signature (tee_verified=true). error: the check failed
 * (tee_verified=false). unverified: a receipt key/provider but no verdict. missing: nothing at all. */
export function receiptStatus(ev: Evidence): ReceiptStatus {
  const r = ev.receipt;
  if (r?.teeVerified === true) return "verified";
  if (r?.teeVerified === false) return "error";
  if (r && (r.resKey || r.provider || r.providerIdentity)) return "unverified";
  return "missing";
}

export function rowStatus(ev: Evidence): RowStatus {
  if (ev.error) return "error";
  if (ev.refusal) return "refused";
  return "ok";
}

// Defence in depth: the router trace should hold IDs/billing only. Drop any key that could carry content.
const CONTENT_KEY = /content|text|prompt|completion|message|input|output|audio|transcript|choices|recipient|address|ip$/i;
const KEEP_KEYS = new Set(["provider", "provider_identity", "provider_address"]);

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (typeof v === "string") return v.length > 256 ? `${v.slice(0, 64)}…(${v.length})` : v;
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (CONTENT_KEY.test(k) && !KEEP_KEYS.has(k)) continue;
    out[k] = scrub(x, depth + 1);
  }
  return out;
}

export function toEvidenceRow(ev: Evidence): EvidenceRow {
  const trace: Record<string, unknown> = {
    x_0g_trace: scrub(ev.rawTrace),
    headers: scrub(ev.rawZgHeaders),
    httpStatus: ev.httpStatus,
    clientRequestId: ev.clientRequestId,
    provider: ev.receipt?.provider ?? null,
    providerIdentity: ev.receipt?.providerIdentity ?? null,
  };
  if (ev.error) trace.error = ev.error;
  if (ev.refusal) trace.refusal = ev.refusal;
  if (ev.txHash) trace.storageTxHash = ev.txHash;
  if (ev.requestIds) trace.requestIds = ev.requestIds.slice(0, 32);
  return {
    kind: KIND[ev.kind] ?? "intent",
    model: ev.model,
    trustMode: String(ev.trustMode),
    requestId: ev.requestId,
    providerResponseKey: ev.receipt?.resKey ?? null,
    receiptSignature: null, // provider signature fetch needs the broker URL (open 0G booth question)
    receiptStatus: receiptStatus(ev),
    teeVerified: ev.receipt?.teeVerified ?? null,
    status: rowStatus(ev),
    latencyMs: ev.latencyMs === null ? null : Math.round(ev.latencyMs),
    rootHash: ev.rootHash ?? null,
    trace,
  };
}

/** `[0g] kind model trust requestId receipt=status` (+ status, and rootHash for storage). No content. */
export function evidenceLine(row: EvidenceRow): string {
  const id = row.kind === "storage" ? (row.rootHash ?? "missing") : (row.requestId ?? "missing");
  return `[0g] ${row.kind} ${row.model} ${row.trustMode} ${id} receipt=${row.receiptStatus} status=${row.status}`;
}

// ---- Prisma (lazy; the generated client lives with packages/database) ----------------------------------

interface ZgEvidenceDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}
interface PrismaLike {
  zgEvidence: ZgEvidenceDelegate;
}

const g = globalThis as typeof globalThis & { __cpayZgPrisma?: PrismaLike | null; __cpayZgWarned?: Set<string> };

function warnOnce(key: string, line: string): void {
  const s = (g.__cpayZgWarned ??= new Set());
  if (s.has(key)) return;
  s.add(key);
  console.warn(line);
}

/**
 * The Prisma client, or null when DATABASE_URL is unset or the client can't load (logged once).
 * `@cpay/database` is a serverExternalPackage (next.config.ts): Node loads it at runtime, webpack doesn't bundle it.
 */
export async function evidenceDb(): Promise<PrismaLike | null> {
  if (!(process.env.DATABASE_URL ?? "").trim()) {
    warnOnce("nodb", "[0g] DATABASE_URL is not set: 0G evidence is logged only, not stored in zg_evidence");
    return null;
  }
  if (g.__cpayZgPrisma !== undefined) return g.__cpayZgPrisma;
  try {
    process.env.DIRECT_URL ||= process.env.DATABASE_URL;
    const { PrismaClient } = (await import("@cpay/database")) as unknown as { PrismaClient: new (o?: unknown) => PrismaLike };
    // No Prisma logging: its error output can echo query arguments. We log one line ourselves.
    g.__cpayZgPrisma = new PrismaClient({ log: [], errorFormat: "minimal" });
  } catch (e) {
    // e.g. `prisma generate` not run. Never fatal: the log line is still written for every call.
    console.error(`[0g] evidence DB unavailable (${(e as Error).name}); run "pnpm --filter @cpay/database db:generate". Logging only.`);
    g.__cpayZgPrisma = null;
  }
  return g.__cpayZgPrisma;
}

/** Test hook: inject a fake client (tests only). */
export function __setEvidenceDbForTests(db: PrismaLike | null | undefined): void {
  g.__cpayZgPrisma = db;
}

/** The evidence sink handed to @cpay/zerog: one log line + one row. Never throws. */
export async function persistEvidence(ev: Evidence): Promise<void> {
  const row = toEvidenceRow(ev);
  console.log(evidenceLine(row));
  const db = await evidenceDb();
  if (!db) return;
  try {
    await db.zgEvidence.create({ data: { ...row } });
  } catch (e) {
    console.error(`[0g] zg_evidence insert FAILED (${(e as { code?: string }).code ?? (e as Error).name}) requestId=${row.requestId ?? "missing"}`);
  }
}

/** Public fields for the /evidence page. */
export interface PublicEvidenceRow {
  requestId: string | null;
  kind: string;
  model: string;
  trustMode: string;
  receiptStatus: string;
  teeVerified: boolean | null;
  rootHash: string | null;
  createdAt: string;
}

export async function recentEvidence(limit = 100): Promise<PublicEvidenceRow[] | null> {
  const db = await evidenceDb();
  if (!db) return null;
  const rows = await db.zgEvidence.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 200),
    select: { requestId: true, kind: true, model: true, trustMode: true, receiptStatus: true, teeVerified: true, rootHash: true, createdAt: true },
  });
  return rows.map((r) => ({
    requestId: (r.requestId as string | null) ?? null,
    kind: String(r.kind),
    model: String(r.model),
    trustMode: String(r.trustMode),
    receiptStatus: String(r.receiptStatus),
    teeVerified: (r.teeVerified as boolean | null) ?? null,
    rootHash: (r.rootHash as string | null) ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}
