/**
 * The glasses bridge. Runs on the payer's Mac.
 *
 * Device side (BRIDGE_HTTP_PORT, all interfaces, the boards dial in over the phone hotspot):
 *   GET  /health        -> {"ok":true,"devices":{...}}
 *   WS   /c3?token=..   -> C3: button events up, OLED lines down
 *   WS   /cam?token=..  -> CAM: capture requests down, binary JPEG frames up
 * Web side (BRIDGE_WS_PORT, 127.0.0.1 only, Origin allow-list):
 *   WS   /              -> the /pay page: BridgeToWeb / WebToBridge (see messages.ts)
 *
 * Holds nothing but the last OLED lines in memory. Frames are forwarded and dropped.
 * Logs never contain image data.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  type BridgeToWeb,
  type DeviceStatus,
  type FrameErrorReason,
  BridgeToC3,
  BridgeToCam,
  C3ToBridge,
  CamToBridge,
  NO_APP_LINES,
  PROTOCOL_VERSION,
  WebToBridge,
  decodeCamFrame,
  parseJson,
} from "./messages.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
};

export interface BridgeOptions {
  httpPort: number; // device side; 0 = random (tests)
  wsPort: number; // web side; 0 = random (tests)
  deviceHost?: string; // default 0.0.0.0
  webHost?: string; // default 127.0.0.1
  deviceToken?: string; // if set, devices must connect with ?token=<value>
  allowedOrigins?: string[]; // browser Origins allowed on the web side; requests without Origin are allowed
  frameTimeoutMs?: number; // default 4000
  heartbeatMs?: number; // device ping interval, default 5000
  logger?: Logger;
}

export const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

const DEVICE_MAX_PAYLOAD = 1024 * 1024; // a VGA JPEG is ~20-80 KB
const WEB_MAX_PAYLOAD = 64 * 1024;

export interface Bridge {
  start(): Promise<{ httpPort: number; wsPort: number }>;
  stop(): Promise<void>;
  devices(): DeviceStatus;
}

export function createBridge(opts: BridgeOptions): Bridge {
  const log = opts.logger ?? consoleLogger;
  const frameTimeoutMs = opts.frameTimeoutMs ?? 4000;
  const heartbeatMs = opts.heartbeatMs ?? 5000;
  const allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const token = opts.deviceToken ?? "";

  let c3: WebSocket | null = null;
  let cam: WebSocket | null = null;
  const webClients = new Set<WebSocket>();
  let oledLines: string[] = [...NO_APP_LINES];
  let nextFrameId = 1;
  let pending: { id: number; timer: NodeJS.Timeout } | null = null;
  const alive = new WeakMap<WebSocket, boolean>();

  const devices = (): DeviceStatus => ({ c3: c3 !== null, cam: cam !== null });

  // ------------------------------------------------------------ web side helpers
  function toWeb(msg: BridgeToWeb) {
    const raw = JSON.stringify(msg);
    for (const ws of webClients) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
  function deviceStatusChanged() {
    const d = devices();
    log.info(`devices: c3=${d.c3 ? "online" : "offline"} cam=${d.cam ? "online" : "offline"}`);
    toWeb({ type: "device_status", devices: d });
  }

  // ------------------------------------------------------------ OLED
  function setOled(lines: string[]) {
    oledLines = lines;
    pushOled();
  }
  function pushOled() {
    if (!c3 || c3.readyState !== WebSocket.OPEN) return;
    const msg = BridgeToC3.parse({ t: "oled", lines: oledLines });
    c3.send(JSON.stringify(msg));
  }

  // ------------------------------------------------------------ frames
  function frameError(id: number | null, reason: FrameErrorReason, detail?: string) {
    log.warn(`frame ${id ?? "-"} error: ${reason}${detail ? ` (${detail})` : ""}`);
    toWeb(detail ? { type: "frame_error", id, reason, detail } : { type: "frame_error", id, reason });
  }

  function requestFrame(source: string) {
    if (!cam || cam.readyState !== WebSocket.OPEN) return frameError(null, "cam_offline");
    if (pending) {
      log.info(`frame request (${source}) ignored: frame ${pending.id} in flight`);
      return frameError(null, "busy");
    }
    const id = nextFrameId++;
    const timer = setTimeout(() => {
      if (pending?.id === id) {
        pending = null;
        frameError(id, "timeout");
      }
    }, frameTimeoutMs);
    pending = { id, timer };
    cam.send(JSON.stringify(BridgeToCam.parse({ t: "capture", id })));
    log.info(`frame ${id} requested (${source})`);
  }

  function onCamBinary(data: Buffer) {
    const frame = decodeCamFrame(data);
    if (!frame) {
      if (pending) {
        const id = pending.id;
        clearTimeout(pending.timer);
        pending = null;
        frameError(id, "bad_frame");
      } else log.warn(`dropped malformed cam frame (${data.length} bytes)`);
      return;
    }
    if (!pending || pending.id !== frame.id) {
      log.warn(`dropped unexpected frame ${frame.id} (${frame.jpeg.length} bytes)`);
      return;
    }
    clearTimeout(pending.timer);
    pending = null;
    const bytes = frame.jpeg.length;
    toWeb({
      type: "frame",
      id: frame.id,
      mime: "image/jpeg",
      bytes,
      dataBase64: Buffer.from(frame.jpeg).toString("base64"),
      ts: Date.now(),
    });
    // metadata only, never image bytes
    log.info(`frame ${frame.id} forwarded to ${webClients.size} web client(s), ${bytes} bytes, dropped`);
  }

  // ------------------------------------------------------------ device connections
  function rawToString(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    return Buffer.from(data).toString("utf8");
  }
  function rawToBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
  }

  function attachC3(ws: WebSocket, remote: string) {
    if (c3) {
      log.info("c3: new connection replaces the old one");
      c3.close(4000, "replaced");
    }
    c3 = ws;
    log.info(`c3 connected from ${remote}`);
    deviceStatusChanged();
    pushOled();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return log.warn("c3 sent binary, ignored");
      const msg = parseJson(C3ToBridge, rawToString(data));
      if (!msg) return log.warn("c3 sent an invalid message, ignored");
      if (msg.t === "hello") return log.info(`c3 hello fw=${msg.fw}`);
      log.info(`button ${msg.e}`);
      toWeb({ type: "button", event: msg.e, ts: Date.now() });
      if (msg.e === "capture_down") requestFrame("capture_down");
    });
    ws.on("close", () => {
      if (c3 !== ws) return;
      c3 = null;
      log.info("c3 disconnected");
      deviceStatusChanged();
    });
  }

  function attachCam(ws: WebSocket, remote: string) {
    if (cam) {
      log.info("cam: new connection replaces the old one");
      cam.close(4000, "replaced");
    }
    cam = ws;
    log.info(`cam connected from ${remote}`);
    deviceStatusChanged();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return onCamBinary(rawToBuffer(data));
      const msg = parseJson(CamToBridge, rawToString(data));
      if (!msg) return log.warn("cam sent an invalid message, ignored");
      if (msg.t === "hello") {
        return log.info(`cam hello fw=${msg.fw} map=${msg.map ?? "?"} camera=${msg.camera ?? "?"} psram=${msg.psram ?? "?"}`);
      }
      if (pending && pending.id === msg.id) {
        clearTimeout(pending.timer);
        pending = null;
        frameError(msg.id, "camera_error", msg.reason);
      }
    });
    ws.on("close", () => {
      if (cam !== ws) return;
      cam = null;
      if (pending) {
        const id = pending.id;
        clearTimeout(pending.timer);
        pending = null;
        frameError(id, "cam_offline");
      }
      log.info("cam disconnected");
      deviceStatusChanged();
    });
  }

  function tokenOk(given: string | null): boolean {
    if (!token) return true;
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ------------------------------------------------------------ servers
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: DEVICE_MAX_PAYLOAD });
  const webWss = new WebSocketServer({ noServer: true, maxPayload: WEB_MAX_PAYLOAD });

  const deviceHttp = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, devices: devices() }));
      return;
    }
    res.writeHead(404).end();
  });

  function reject(socket: Duplex, code: number, text: string) {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  deviceHttp.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://device");
    const role = url.pathname === "/c3" ? "c3" : url.pathname === "/cam" ? "cam" : null;
    const remote = req.socket.remoteAddress ?? "?";
    if (!role) return reject(socket, 404, "Not Found");
    if (!tokenOk(url.searchParams.get("token"))) {
      log.warn(`${role} from ${remote} rejected: bad token`);
      return reject(socket, 401, "Unauthorized");
    }
    deviceWss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      if (role === "c3") attachC3(ws, remote);
      else attachCam(ws, remote);
    });
  });

  const webHttp = http.createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" }).end("WebSocket only");
  });

  webHttp.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    // Browsers always send Origin. Without this check any website open in the payer's browser
    // could connect to localhost and read glasses frames.
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      log.warn(`web client rejected: origin ${origin} not allowed (BRIDGE_ALLOWED_ORIGINS)`);
      return reject(socket, 403, "Forbidden");
    }
    webWss.handleUpgrade(req, socket, head, (ws) => attachWeb(ws, origin ?? "(no origin)"));
  });

  function attachWeb(ws: WebSocket, origin: string) {
    webClients.add(ws);
    log.info(`web client connected (${origin}), ${webClients.size} total`);
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, devices: devices() } satisfies BridgeToWeb));
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? null : parseJson(WebToBridge, rawToString(data));
      if (!msg) {
        log.warn("web client sent an invalid message");
        ws.send(JSON.stringify({ type: "error", reason: "invalid message" } satisfies BridgeToWeb));
        return;
      }
      if (msg.type === "oled") {
        log.info(`oled <- web: ${JSON.stringify(msg.lines)}${c3 ? "" : " (c3 offline, will replay)"}`);
        setOled(msg.lines);
      } else requestFrame("web");
    });
    ws.on("close", () => {
      webClients.delete(ws);
      log.info(`web client disconnected, ${webClients.size} left`);
      if (webClients.size === 0) setOled([...NO_APP_LINES]);
    });
  }

  let heartbeat: NodeJS.Timeout | null = null;

  function listen(server: http.Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  return {
    devices,
    async start() {
      if (!token) log.warn("BRIDGE_DEVICE_TOKEN not set: any device on the hotspot can connect");
      const httpPort = await listen(deviceHttp, opts.httpPort, opts.deviceHost ?? "0.0.0.0");
      const wsPort = await listen(webHttp, opts.wsPort, opts.webHost ?? "127.0.0.1");
      heartbeat = setInterval(() => {
        for (const ws of deviceWss.clients) {
          if (alive.get(ws) === false) {
            log.warn("device missed heartbeat, dropping");
            ws.terminate();
            continue;
          }
          alive.set(ws, false);
          ws.ping();
        }
      }, heartbeatMs);
      log.info(`bridge up: devices ws://0.0.0.0:${httpPort}/{c3,cam}, web ws://${opts.webHost ?? "127.0.0.1"}:${wsPort}`);
      return { httpPort, wsPort };
    },
    async stop() {
      if (heartbeat) clearInterval(heartbeat);
      if (pending) clearTimeout(pending.timer);
      for (const ws of [...deviceWss.clients, ...webWss.clients]) ws.terminate();
      await Promise.all([
        new Promise<void>((r) => deviceHttp.close(() => r())),
        new Promise<void>((r) => webHttp.close(() => r())),
      ]);
    },
  };
}
