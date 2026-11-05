/**
 * ============================  TEST / DEV ONLY  ============================
 * Fake C3 + CAM for testing the bridge and the web app without hardware.
 * NEVER part of the demo path: the demo uses the real glasses. It's a separate
 * entry point (`npm run sim`) and nothing imports it.
 * ===========================================================================
 *
 * Usage:  npm run sim -- [--host 127.0.0.1] [--port 8790] [--jpeg ./some.jpg] [--no-cam]
 * Keys:   c = CAPTURE (down, then up after 1.5 s)   y = CONFIRM   n = CANCEL   q = quit
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { BridgeToC3, BridgeToCam, parseJson } from "./messages.js";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: process.env.BRIDGE_HTTP_PORT ?? "8790" },
    jpeg: { type: "string" },
    token: { type: "string", default: process.env.BRIDGE_DEVICE_TOKEN ?? "" },
    "no-cam": { type: "boolean", default: false },
  },
});

// A tiny grey placeholder JPEG (TEST DATA, not a face). Use --jpeg to send a real file.
const PLACEHOLDER_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
const jpeg = values.jpeg ? readFileSync(values.jpeg) : PLACEHOLDER_JPEG;
const base = `ws://${values.host}:${values.port}`;
const q = values.token ? `?token=${encodeURIComponent(values.token)}` : "";

console.log("\n*** CPay glasses SIMULATOR: TEST / DEV ONLY, not the real glasses ***\n");

function connect(role: "c3" | "cam", onOpen: (ws: WebSocket) => void): WebSocket {
  const ws = new WebSocket(`${base}/${role}${q}`);
  ws.on("open", () => {
    console.log(`[sim ${role}] connected to ${base}/${role}`);
    onOpen(ws);
  });
  ws.on("close", () => console.log(`[sim ${role}] disconnected`));
  ws.on("error", (e) => console.log(`[sim ${role}] error: ${e.message}`));
  return ws;
}

const c3 = connect("c3", (ws) => ws.send(JSON.stringify({ t: "hello", role: "c3", fw: "sim" })));
c3.on("message", (data) => {
  const msg = parseJson(BridgeToC3, data.toString());
  if (msg) console.log(`[sim c3] OLED: | ${msg.lines.join(" | ")} |`);
});

if (!values["no-cam"]) {
  const cam = connect("cam", (ws) =>
    ws.send(JSON.stringify({ t: "hello", role: "cam", fw: "sim", map: "SIM", camera: true, psram: true })),
  );
  cam.on("message", (data) => {
    const msg = parseJson(BridgeToCam, data.toString());
    if (!msg) return;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(msg.id);
    cam.send(Buffer.concat([header, jpeg]), { binary: true });
    console.log(`[sim cam] sent frame ${msg.id} (${jpeg.length} bytes, TEST DATA)`);
  });
}

function btn(e: string) {
  if (c3.readyState !== WebSocket.OPEN) return console.log("[sim c3] not connected");
  c3.send(JSON.stringify({ t: "btn", e }));
  console.log(`[sim c3] button ${e}`);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key: string) => {
  if (key === "q" || key === "\u0003") process.exit(0);
  if (key === "c") {
    btn("capture_down");
    setTimeout(() => btn("capture_up"), 1500);
  } else if (key === "y") btn("confirm");
  else if (key === "n") btn("cancel");
});
console.log("keys: c = capture (push-to-talk 1.5 s), y = confirm, n = cancel, q = quit");
