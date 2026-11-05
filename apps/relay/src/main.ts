import { createRelay } from "./relay.js";

const port = Number(process.env.RELAY_PORT ?? 8787);
const relay = createRelay({ port });
const bound = await relay.ready;
// The only log line: no payloads, IPs or peer identities, ever.
console.log(`[relay] listening on ws://localhost:${bound}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void relay.close().then(() => process.exit(0)));
}
