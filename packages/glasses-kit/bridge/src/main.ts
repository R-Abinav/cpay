/** Entry point: `npm run bridge` (reads env; see README.md). */
import { networkInterfaces } from "node:os";
import { DEFAULT_ALLOWED_ORIGINS, createBridge } from "./bridge.js";

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number, got ${raw}`);
  return n;
}

const bridge = createBridge({
  httpPort: port("BRIDGE_HTTP_PORT", 8790),
  wsPort: port("BRIDGE_WS_PORT", 8791),
  deviceToken: process.env.BRIDGE_DEVICE_TOKEN ?? "",
  allowedOrigins: process.env.BRIDGE_ALLOWED_ORIGINS
    ? process.env.BRIDGE_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS,
});

const { httpPort } = await bridge.start();

// Print the Mac's LAN addresses so the human can put the right one in secrets.h (BRIDGE_HOST).
const ips = Object.entries(networkInterfaces())
  .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
  .filter((a) => a.family === "IPv4" && !a.internal);
for (const a of ips) console.log(`  device URL candidate: ws://${a.address}:${httpPort}  (${a.name})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void bridge.stop().then(() => process.exit(0));
  });
}
