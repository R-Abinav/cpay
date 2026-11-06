import { initCredential } from "@cpay/credential";
import { createRelay, DEFAULT_RELAY_LIMITS } from "./relay.js";

// Render injects PORT; locally RELAY_PORT (default 8787).
const port = Number(process.env.PORT ?? process.env.RELAY_PORT ?? 8787);

/** A positive integer from the environment, else the default. */
function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Per-IP connection caps (memory-only counters; IPs are never logged). Generous: a venue shares one NAT IP.
const limits = {
  maxConnsPerIp: intEnv("RELAY_MAX_CONNS_PER_IP", DEFAULT_RELAY_LIMITS.maxConnsPerIp),
  newConnsPerMinutePerIp: intEnv("RELAY_MAX_NEW_CONNS_PER_MIN_PER_IP", DEFAULT_RELAY_LIMITS.newConnsPerMinutePerIp),
};
// Only behind Render's proxy: trust the right-most X-Forwarded-For entry.
const trustProxy = process.env.RELAY_TRUST_PROXY === "1";

// Issuer BBS public key, to verify recipient.hello: ISSUER_BBS_PUBLIC_KEY, else GET <ISSUER_URL>/issuer-key
// (fetched on the first hello, retried until it works). Neither set: every recipient is refused.
const staticKey = process.env.ISSUER_BBS_PUBLIC_KEY?.trim();
let issuerUrl = (process.env.ISSUER_URL ?? process.env.NEXT_PUBLIC_ISSUER_URL ?? "").trim().replace(/\/+$/, "");
if (issuerUrl && !/^https?:\/\//.test(issuerUrl)) issuerUrl = `https://${issuerUrl}`; // a bare Render host
const issuerPublicKey = staticKey
  ? staticKey
  : issuerUrl
    ? async () => {
        const r = await fetch(`${issuerUrl}/issuer-key`);
        if (!r.ok) throw new Error(`issuer-key ${r.status}`);
        const b = (await r.json()) as { publicKey?: unknown };
        if (typeof b.publicKey !== "string" || !b.publicKey) throw new Error("issuer-key: bad body");
        return b.publicKey;
      }
    : undefined;

await initCredential();
const relay = createRelay({ port, issuerPublicKey, limits, trustProxy });
const bound = await relay.ready;
// The only log lines: no payloads, IPs or peer identities, ever.
console.log(`[relay] listening on port ${bound} (ws + GET /health)`);
if (!issuerPublicKey) console.log("[relay] no ISSUER_BBS_PUBLIC_KEY / ISSUER_URL: recipients are refused");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void relay.close().then(() => process.exit(0)));
}
