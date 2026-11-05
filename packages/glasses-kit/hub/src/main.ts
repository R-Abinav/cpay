/**
 * cpay-hub entry. Env: PORT (Render) or HUB_PORT, HUB_ALLOWED_ORIGINS, HUB_PAIRING_CODE_TTL_SECONDS,
 * HUB_TICKET_TTL_SECONDS, HUB_TICKET_SECRET, DATABASE_URL (unset = in-memory store, dev only).
 */
import { createHub } from "./hub.js";
import { LIMITS } from "./messages.js";
import { createPrismaUnitStore, MemoryUnitStore, type UnitStore } from "./store.js";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

const port = num("PORT", num("HUB_PORT", 8790));
const ticketSecret = process.env.HUB_TICKET_SECRET ?? "";
if (ticketSecret.length < 32) {
  console.error("[hub] HUB_TICKET_SECRET missing or shorter than 32 chars; refusing to start");
  process.exit(1);
}
const allowedOrigins = (process.env.HUB_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) console.warn("[hub] HUB_ALLOWED_ORIGINS empty: every phone connection will be rejected");

let store: UnitStore;
if (process.env.DATABASE_URL) {
  store = await createPrismaUnitStore();
  console.log("[hub] store=postgres");
} else {
  store = new MemoryUnitStore();
  console.log("[hub] DATABASE_URL unset: using in-memory store (pairings lost on restart; dev only)");
}

const hub = createHub({
  store,
  ticketSecret,
  ticketTtlSeconds: num("HUB_TICKET_TTL_SECONDS", 3600),
  pairingCodeTtlSeconds: num("HUB_PAIRING_CODE_TTL_SECONDS", LIMITS.pairingCodeTtlSeconds),
  allowedOrigins,
});
const bound = await hub.listen(port);
console.log(`[hub] listening port=${bound} origins=${allowedOrigins.length}`);

const shutdown = async () => {
  await hub.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
