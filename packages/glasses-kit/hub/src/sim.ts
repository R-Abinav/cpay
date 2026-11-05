/**
 * DEV TOOL ONLY (never in the demo path): a fake glasses unit for the hub.
 * Connects to /device, registers on first contact, prints the pairing code, shows OLED text on stdout and
 * streams a JPEG while the hub says stream on.
 *
 *   pnpm --filter @cpay/glasses-kit hub:sim [--url ws://localhost:8790] [--unit sim-unit-1] [--jpeg file.jpg]
 *
 * The secret is random per process unless SIM_UNIT_SECRET (64 hex) is set; reuse it to keep a pairing
 * across sim restarts (otherwise use a new --unit id).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { DEVICE_AUTH_PREFIX, HubToDevice, type DeviceToHub } from "./messages.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = arg("url", process.env.HUB_DEVICE_URL ?? "ws://localhost:8790").replace(/\/$/, "") + "/device";
const unitId = arg("unit", "sim-unit-1");
const secret = process.env.SIM_UNIT_SECRET ?? randomBytes(32).toString("hex");
const jpegPath = arg("jpeg", "");
// Without --jpeg: a minimal SOI..EOI buffer. The hub only checks the FF D8 prefix; the phone can't decode it.
const jpeg = jpegPath ? readFileSync(jpegPath) : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const key = createHash("sha256").update(Buffer.from(secret, "hex")).digest();

const ws = new WebSocket(url);
let streamTimer: NodeJS.Timeout | null = null;
const send = (m: DeviceToHub) => ws.send(JSON.stringify(m));

ws.on("open", () => console.log(`[sim] connected ${url} unit=${unitId}`));
ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  const r = HubToDevice.safeParse(JSON.parse(data.toString()));
  if (!r.success) return console.log("[sim] unknown message");
  const m = r.data;
  switch (m.t) {
    case "challenge": {
      const mac = createHmac("sha256", key).update(DEVICE_AUTH_PREFIX + m.nonce).digest("hex");
      return send({ t: "auth", unitId, fw: "sim-0.1", mac });
    }
    case "register":
      console.log("[sim] hub asked to register (first contact)");
      return send({ t: "register", unitId, secret });
    case "auth_ok":
      console.log(`[sim] auth ok, paired=${m.paired}`);
      setInterval(() => send({ t: "status", rssi: -55, heap: 120_000, fps: streamTimer ? 5 : 0 }), 10_000).unref();
      return;
    case "pair_code":
      return console.log(`[sim] OLED: PAIR CODE ${m.code} (expires ${new Date(m.exp * 1000).toISOString()})`);
    case "paired":
      return console.log("[sim] OLED: PAIRED");
    case "oled":
      return console.log(`[sim] OLED: ${m.lines.join(" | ")}`);
    case "stream":
      if (streamTimer) clearInterval(streamTimer);
      streamTimer = null;
      if (m.on) streamTimer = setInterval(() => ws.send(jpeg, { binary: true }), Math.round(1000 / m.fps));
      return console.log(`[sim] stream ${m.on ? `on ${m.fps} fps` : "off"}`);
  }
});
ws.on("close", (code, reason) => {
  console.log(`[sim] closed ${code} ${reason.toString()}`);
  process.exit(0);
});
ws.on("error", (e) => console.error(`[sim] ${e.message}`));
