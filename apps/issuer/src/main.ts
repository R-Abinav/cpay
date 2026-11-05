import { serve } from "@hono/node-server";
import { initCredential } from "@cpay/credential";
import { createIssuerApp } from "./app.js";
import { loadEnv } from "./config.js";
import { openNullifierStore } from "./db.js";

const env = loadEnv();
await initCredential();
const store = openNullifierStore(env.dbPath);
const app = createIssuerApp({ ...env, store });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[issuer] listening on http://localhost:${info.port} (World ${env.environment})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
