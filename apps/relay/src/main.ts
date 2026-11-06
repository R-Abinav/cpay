import { initCredential } from "@cpay/credential";
import { createRelay } from "./relay.js";

const port = Number(process.env.RELAY_PORT ?? 8787);

// Issuer BBS public key, to verify recipient.hello: ISSUER_BBS_PUBLIC_KEY, else GET <ISSUER_URL>/issuer-key
// (fetched on the first hello, retried until it works). Neither set: every recipient is refused.
const staticKey = process.env.ISSUER_BBS_PUBLIC_KEY?.trim();
const issuerUrl = (process.env.ISSUER_URL ?? process.env.NEXT_PUBLIC_ISSUER_URL ?? "").trim().replace(/\/+$/, "");
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
const relay = createRelay({ port, issuerPublicKey });
const bound = await relay.ready;
// The only log lines: no payloads, IPs or peer identities, ever.
console.log(`[relay] listening on ws://localhost:${bound}`);
if (!issuerPublicKey) console.log("[relay] no ISSUER_BBS_PUBLIC_KEY / ISSUER_URL: recipients are refused");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void relay.close().then(() => process.exit(0)));
}
