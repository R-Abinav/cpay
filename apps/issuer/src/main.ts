import { serve } from "@hono/node-server";
import { initCredential } from "@cpay/credential";
import { createIssuerApp } from "./app.js";
import { loadEnv } from "./config.js";
import { MemoryNullifierStore, createPrismaNullifierStore, type NullifierStore } from "./db.js";

const env = loadEnv();
await initCredential();

// Supabase Postgres when DATABASE_URL is set. Without it, a memory store for local dev only: refused
// in production, because losing nullifiers on restart would let one human enrol twice.
let store: NullifierStore;
if (env.databaseUrl) {
  store = await createPrismaNullifierStore();
} else if (process.env.NODE_ENV === "production") {
  throw new Error("issuer: DATABASE_URL is required in production");
} else {
  console.warn("[issuer] DATABASE_URL not set: in-memory nullifiers (local dev only, lost on restart)");
  store = new MemoryNullifierStore();
}

const app = createIssuerApp({ ...env, store });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[issuer] listening on http://localhost:${info.port} (World ${env.environments.join("+")}, store ${store.kind})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    void store.close().finally(() => process.exit(0));
  });
}
