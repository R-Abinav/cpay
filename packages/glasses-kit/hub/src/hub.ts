/**
 * CPay glasses hub (Render `cpay-hub`). Contract: ./messages.ts (protocol 3).
 *
 *   /device  ESP32-CAM: HMAC challenge-response (TOFU register), pairing codes, OLED, stream control, JPEG frames
 *   /phone   PWA: pair/auth with an owner token, scan on/off, OLED text, hub tickets, unpair
 *   /health  {ok:true}
 *
 * Privacy (CLAUDE.md invariants 3 + 4): frames, OLED text and status live in memory only, are forwarded to
 * the paired phone and dropped. The store holds only unit_id, sha256(unit_secret), sha256(owner_token).
 * Pairing lasts one power-on: the glasses' per-boot random id is kept in memory only (messages.ts).
 * Heartbeat: every socket is pinged every 5 s and terminated after ~10 s of silence (power cut = offline).
 * Logs: event names with counts/sizes. Never tokens, codes, secrets, IPs, unit ids, image data or OLED text.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  DEVICE_AUTH_PREFIX,
  DeviceToHub,
  HEARTBEAT,
  LIMITS,
  PAIRING_CODE_ALPHABET,
  PHONE_CLOSE_UNPAIRED,
  PROTOCOL_VERSION,
  PhoneToHub,
  type HubToDevice,
  type HubToPhone,
  type OledLines,
  type UnpairReason,
} from "./messages.js";
import type { UnitStore } from "./store.js";
import { issueTicket } from "./ticket.js";

export interface HubOptions {
  store: UnitStore;
  ticketSecret: string;
  ticketTtlSeconds: number;
  /** Exact Origin values allowed on /phone. */
  allowedOrigins: string[];
  pairingCodeTtlSeconds?: number;
  /** Stream cap without a fresh scan{on}; defaults to LIMITS.streamMaxMs (tests shorten it). */
  streamMaxMs?: number;
  /** A device must finish auth within this time. */
  deviceAuthTimeoutMs?: number;
  /** Ping interval for every socket; defaults to HEARTBEAT.pingEveryMs. */
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export interface Hub {
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const STREAM_FPS = 5;
const PHONE_MSGS_PER_SEC = 20;
const DEVICE_MSGS_PER_SEC = 10;
const DEVICE_FRAMES_PER_SEC = 15;
const MAX_BAD_CODES = 5;
/** Drop a frame instead of queueing when the phone's socket is this far behind. */
const PHONE_BACKLOG_MAX = 512 * 1024;

type Live = {
  unitId: string;
  device: DeviceConn | null;
  phones: Set<PhoneConn>;
  paired: boolean;
  lastOled: OledLines | null;
  code: { code: string; exp: number; timer: NodeJS.Timeout } | null;
  scanOn: boolean;
  scanTimer: NodeJS.Timeout | null;
  seq: number;
  frames: { fwd: number; dropped: number; bytes: number };
  /** Last device status, memory only (not forwarded, not logged). */
  status: { rssi: number; heap: number; fps: number } | null;
  /** Boot id of the glasses' current power-on, memory only (never stored, never logged). null = not seen since hub start. */
  bootId: string | null;
};

type DeviceConn = { ws: WebSocket; unit: Live | null };
type PhoneConn = { ws: WebSocket; unit: Live | null; badCodes: number };

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** mac = hex(HMAC-SHA256(key = sha256(secret bytes), DEVICE_AUTH_PREFIX + nonce)). See messages.ts. */
export function deviceMac(unitSecretHashHex: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(unitSecretHashHex, "hex")).update(DEVICE_AUTH_PREFIX + nonce).digest("hex");
}

function macEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

function newCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  return s;
}

/** Fixed one-second window counter. */
function rateLimiter(perSec: number) {
  let windowStart = 0;
  let n = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      n = 0;
    }
    return ++n <= perSec;
  };
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function createHub(opts: HubOptions): Hub {
  const store = opts.store;
  const streamMaxMs = opts.streamMaxMs ?? LIMITS.streamMaxMs;
  const codeTtlMs = (opts.pairingCodeTtlSeconds ?? LIMITS.pairingCodeTtlSeconds) * 1000;
  const authTimeoutMs = opts.deviceAuthTimeoutMs ?? 10_000;
  const log = opts.log ?? ((l: string) => console.log(l));
  const ev = (event: string, fields: Record<string, number | boolean | string> = {}) =>
    log(["[hub]", event, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(" "));
  const allowed = new Set(opts.allowedOrigins);

  const units = new Map<string, Live>();
  const codes = new Map<string, Live>();

  const liveFor = (unitId: string): Live => {
    let u = units.get(unitId);
    if (!u) {
      u = {
        unitId,
        device: null,
        phones: new Set(),
        paired: false,
        lastOled: null,
        code: null,
        scanOn: false,
        scanTimer: null,
        seq: 0,
        frames: { fwd: 0, dropped: 0, bytes: 0 },
        status: null,
        bootId: null,
      };
      units.set(unitId, u);
    }
    return u;
  };

  const sendDevice = (u: Live, m: HubToDevice) => {
    if (u.device?.ws.readyState === WebSocket.OPEN) u.device.ws.send(JSON.stringify(m));
  };
  const sendPhone = (p: PhoneConn, m: HubToPhone) => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(m));
  };
  const toPhones = (u: Live, m: HubToPhone) => {
    for (const p of u.phones) sendPhone(p, m);
  };

  // ------------------------------------------------------------- pairing codes

  const dropCode = (u: Live) => {
    if (!u.code) return;
    clearTimeout(u.code.timer);
    codes.delete(u.code.code);
    u.code = null;
  };

  /** Shows a fresh single-use code on an online, unpaired unit; renews itself on expiry. */
  const issueCode = (u: Live) => {
    dropCode(u);
    if (!u.device || u.paired) return;
    let code = newCode();
    while (codes.has(code)) code = newCode();
    const exp = Date.now() + codeTtlMs;
    const timer = setTimeout(() => {
      ev("pair code expired");
      issueCode(u);
    }, codeTtlMs);
    timer.unref();
    u.code = { code, exp, timer };
    codes.set(code, u);
    sendDevice(u, { t: "pair_code", code, exp: Math.ceil(exp / 1000) });
    ev("pair code issued", { ttlS: codeTtlMs / 1000 });
  };

  // ------------------------------------------------------------- scanning

  const stopScan = (u: Live, reason: "phone" | "timeout" | "device_offline") => {
    if (u.scanTimer) clearTimeout(u.scanTimer);
    u.scanTimer = null;
    if (!u.scanOn) return;
    u.scanOn = false;
    sendDevice(u, { t: "stream", on: false, fps: STREAM_FPS, size: "QVGA" });
    toPhones(u, { type: "scan_state", on: false, reason });
    ev("scan off", { reason, fwd: u.frames.fwd, dropped: u.frames.dropped, bytes: u.frames.bytes });
    u.frames = { fwd: 0, dropped: 0, bytes: 0 };
  };

  const startScan = (u: Live) => {
    if (u.scanTimer) clearTimeout(u.scanTimer);
    u.scanTimer = setTimeout(() => stopScan(u, "timeout"), streamMaxMs);
    u.scanTimer.unref();
    // Re-send on every refresh: the firmware stops its camera after 20 s without a stream{on}.
    sendDevice(u, { t: "stream", on: true, fps: STREAM_FPS, size: "QVGA" });
    if (u.scanOn) return; // refresh only
    u.scanOn = true;
    toPhones(u, { type: "scan_state", on: true, reason: "phone" });
    ev("scan on");
  };

  /** Ends the live pairing: camera off, OLED text dropped, paired phones closed (they forget their token). */
  const endPairing = (u: Live, exceptPhone: PhoneConn | null, reason: UnpairReason) => {
    stopScan(u, "phone");
    u.paired = false;
    u.lastOled = null;
    for (const p of [...u.phones]) {
      u.phones.delete(p);
      p.unit = null;
      if (p !== exceptPhone) p.ws.close(PHONE_CLOSE_UNPAIRED, reason);
    }
  };

  const unpairLive = (u: Live, exceptPhone: PhoneConn | null) => {
    endPairing(u, exceptPhone, "unpaired");
    issueCode(u);
  };

  // ------------------------------------------------------------- device

  const onDevice = (ws: WebSocket) => {
    const conn: DeviceConn = { ws, unit: null };
    const nonce = randomBytes(32).toString("hex");
    let pending: { unitId: string; mac: string; boot: string | undefined } | null = null;
    let chain = Promise.resolve();
    const msgOk = rateLimiter(DEVICE_MSGS_PER_SEC);
    const frameOk = rateLimiter(DEVICE_FRAMES_PER_SEC);
    const authTimer = setTimeout(() => {
      if (!conn.unit) ws.close(4001, "auth timeout");
    }, authTimeoutMs);
    authTimer.unref();

    const accept = async (unitId: string, boot: string | undefined) => {
      clearTimeout(authTimer);
      const rec = await store.getUnit(unitId);
      const u = liveFor(unitId);
      let paired = !!rec?.ownerTokenHash;
      // Pairing lasts one power-on (messages.ts): a new boot id means the glasses restarted. No boot id
      // remembered (hub restarted) or none sent (older firmware): keep the stored pairing.
      const restarted = boot !== undefined && u.bootId !== null && u.bootId !== boot;
      if (restarted) {
        if (paired) await store.setOwner(unitId, null); // before remembering the boot id, so a failed write retries
        paired = false;
        endPairing(u, null, "glasses_restarted");
        ev("glasses restarted, unpaired");
      }
      if (boot !== undefined) u.bootId = boot;
      if (ws.readyState !== WebSocket.OPEN) return; // dropped while we awaited the store
      if (u.device && u.device !== conn) {
        const old = u.device;
        old.unit = null;
        old.ws.close(4004, "replaced");
      }
      u.device = conn;
      conn.unit = u;
      u.paired = paired;
      ws.send(JSON.stringify({ t: "auth_ok", paired: u.paired } satisfies HubToDevice));
      ev("device online", { paired: u.paired, phones: u.phones.size });
      toPhones(u, { type: "device_status", online: true });
      if (!u.paired) issueCode(u);
      else if (u.lastOled) sendDevice(u, { t: "oled", lines: u.lastOled });
    };

    const handleJson = async (text: string) => {
      let msg: DeviceToHub;
      try {
        const r = DeviceToHub.safeParse(JSON.parse(text));
        if (!r.success) throw new Error();
        msg = r.data;
      } catch {
        ev("device bad message", { bytes: text.length });
        return;
      }
      if (msg.t === "status") {
        if (conn.unit) conn.unit.status = { rssi: msg.rssi, heap: msg.heap, fps: msg.fps };
        return;
      }
      if (conn.unit) return; // already authenticated: ignore repeated auth/register
      if (msg.t === "auth") {
        if (pending) return;
        const rec = await store.getUnit(msg.unitId);
        if (!rec) {
          pending = { unitId: msg.unitId, mac: msg.mac, boot: msg.boot };
          ws.send(JSON.stringify({ t: "register" } satisfies HubToDevice));
          ev("device unknown, register requested");
          return;
        }
        if (!macEquals(deviceMac(rec.unitSecretHash, nonce), msg.mac)) {
          ev("device auth failed");
          ws.close(4001, "bad mac");
          return;
        }
        await accept(msg.unitId, msg.boot);
        return;
      }
      // register
      if (!pending || pending.unitId !== msg.unitId) {
        ws.close(4001, "unexpected register");
        return;
      }
      const hash = sha256hex(Buffer.from(msg.secret, "hex"));
      if (!macEquals(deviceMac(hash, nonce), pending.mac)) {
        ev("device register failed");
        ws.close(4001, "bad mac");
        return;
      }
      const created = await store.registerUnit(msg.unitId, hash);
      if (!created) {
        // Raced with another registration: the stored hash wins; verify against it.
        const rec = await store.getUnit(msg.unitId);
        if (!rec || !macEquals(deviceMac(rec.unitSecretHash, nonce), pending.mac)) {
          ws.close(4001, "bad mac");
          return;
        }
      }
      ev("device registered");
      await accept(msg.unitId, pending.boot);
    };

    const handleFrame = (buf: Buffer) => {
      const u = conn.unit;
      if (!u) return;
      if (!u.scanOn || !frameOk() || buf.length > LIMITS.frameMaxBytes || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        u.frames.dropped++;
        return;
      }
      const msg = JSON.stringify({
        type: "frame",
        seq: u.seq++,
        ts: Date.now(),
        mime: "image/jpeg",
        dataBase64: buf.toString("base64"),
      } satisfies HubToPhone);
      let sent = false;
      for (const p of u.phones) {
        if (p.ws.readyState === WebSocket.OPEN && p.ws.bufferedAmount < PHONE_BACKLOG_MAX) {
          p.ws.send(msg);
          sent = true;
        }
      }
      if (sent) {
        u.frames.fwd++;
        u.frames.bytes += buf.length;
      } else u.frames.dropped++;
    };

    ws.on("message", (data, isBinary) => {
      const buf = rawToBuffer(data);
      if (isBinary) return handleFrame(buf);
      if (buf.length > LIMITS.jsonMaxBytes || !msgOk()) return;
      chain = chain
        .then(() => handleJson(buf.toString("utf8")))
        .catch(() => {
          ev("device handler error");
          ws.close(1011, "error");
        });
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      const u = conn.unit;
      conn.unit = null;
      if (!u || u.device !== conn) return;
      u.device = null;
      u.status = null;
      stopScan(u, "device_offline");
      dropCode(u);
      toPhones(u, { type: "device_status", online: false });
      ev("device offline", { phones: u.phones.size });
    });
    ws.on("error", () => {});

    ws.send(JSON.stringify({ t: "challenge", nonce } satisfies HubToDevice));
  };

  // ------------------------------------------------------------- phone

  const onPhone = (ws: WebSocket) => {
    const conn: PhoneConn = { ws, unit: null, badCodes: 0 };
    let chain = Promise.resolve();
    const msgOk = rateLimiter(PHONE_MSGS_PER_SEC);

    const sendTicket = () => {
      const t = issueTicket(opts.ticketSecret, opts.ticketTtlSeconds);
      sendPhone(conn, { type: "ticket", token: t.token, exp: t.claims.exp });
      ev("ticket issued");
    };

    const bind = (u: Live) => {
      conn.unit = u;
      u.phones.add(conn);
      sendPhone(conn, { type: "hello", protocol: PROTOCOL_VERSION, online: !!u.device });
      sendTicket();
    };

    const handle = async (text: string) => {
      let msg: PhoneToHub;
      try {
        const r = PhoneToHub.safeParse(JSON.parse(text));
        if (!r.success) throw new Error();
        msg = r.data;
      } catch {
        sendPhone(conn, { type: "error", code: "bad_message" });
        ev("phone bad message", { bytes: text.length });
        return;
      }

      if (msg.type === "pair") {
        const u = codes.get(msg.code);
        if (!u || !u.code || u.code.exp <= Date.now() || !u.device || u.paired) {
          conn.badCodes++;
          sendPhone(conn, { type: "error", code: "bad_code" });
          ev("pair failed", { attempts: conn.badCodes });
          if (conn.badCodes >= MAX_BAD_CODES) ws.close(4008, "too many attempts");
          return;
        }
        dropCode(u); // single use, before any await
        const hash = sha256hex(msg.ownerToken);
        const prev = await store.findByOwnerHash(hash);
        if (prev && prev.unitId !== u.unitId) {
          await store.setOwner(prev.unitId, null);
          const pu = units.get(prev.unitId);
          if (pu) unpairLive(pu, null);
        }
        if (conn.unit && conn.unit !== u) {
          conn.unit.phones.delete(conn);
          conn.unit = null;
        }
        await store.setOwner(u.unitId, hash);
        u.paired = true;
        u.lastOled = null;
        sendDevice(u, { t: "paired" });
        ev("paired");
        bind(u);
        return;
      }

      if (msg.type === "auth") {
        if (conn.unit) return;
        const rec = await store.findByOwnerHash(sha256hex(msg.ownerToken));
        if (!rec) {
          sendPhone(conn, { type: "error", code: "unauthorized" });
          ev("phone auth failed");
          return;
        }
        const u = liveFor(rec.unitId);
        u.paired = true;
        ev("phone online", { deviceOnline: !!u.device });
        bind(u);
        return;
      }

      const u = conn.unit;
      if (!u) {
        sendPhone(conn, { type: "error", code: "not_authenticated" });
        return;
      }

      switch (msg.type) {
        case "scan":
          if (!msg.on) return stopScan(u, "phone");
          if (!u.device) return sendPhone(conn, { type: "error", code: "device_offline" });
          return startScan(u);
        case "oled":
          u.lastOled = msg.lines;
          if (!u.device) return sendPhone(conn, { type: "error", code: "device_offline" });
          sendDevice(u, { t: "oled", lines: msg.lines });
          return;
        case "ticket_request":
          return sendTicket();
        case "unpair":
          await store.setOwner(u.unitId, null);
          unpairLive(u, conn);
          ev("unpaired");
          ws.close(1000, "unpaired");
          return;
      }
    };

    ws.on("message", (data, isBinary) => {
      const buf = rawToBuffer(data);
      if (isBinary || buf.length > LIMITS.jsonMaxBytes) {
        sendPhone(conn, { type: "error", code: "bad_message" });
        return;
      }
      if (!msgOk()) {
        sendPhone(conn, { type: "error", code: "rate_limited" });
        return;
      }
      chain = chain
        .then(() => handle(buf.toString("utf8")))
        .catch(() => {
          ev("phone handler error");
          ws.close(1011, "error");
        });
    });

    ws.on("close", () => {
      const u = conn.unit;
      conn.unit = null;
      if (!u) return;
      u.phones.delete(conn);
      if (u.phones.size === 0) stopScan(u, "phone"); // camera never runs without a phone watching
      ev("phone offline", { phones: u.phones.size });
    });
    ws.on("error", () => {});
  };

  // ------------------------------------------------------------- http + upgrade

  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frameMaxBytes * 2 });
  const phoneWss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.jsonMaxBytes * 2 });
  deviceWss.on("connection", onDevice);
  phoneWss.on("connection", onPhone);

  // Heartbeat: a power cut doesn't close TCP, so ping every socket and terminate one that stops answering.
  // terminate() fires the normal close handler (device: scan off "device_offline" + device_status offline).
  const missed = new WeakMap<WebSocket, number>();
  const watch = (ws: WebSocket) => {
    missed.set(ws, 0);
    const alive = () => missed.set(ws, 0);
    ws.on("pong", alive);
    ws.on("message", alive);
  };
  deviceWss.on("connection", watch);
  phoneWss.on("connection", watch);
  const beat = (wss: WebSocketServer, kind: "device" | "phone") => {
    for (const ws of wss.clients) {
      const n = missed.get(ws) ?? 0;
      if (n >= HEARTBEAT.maxMissed) {
        ev(`${kind} heartbeat lost`);
        ws.terminate();
        continue;
      }
      missed.set(ws, n + 1);
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  };
  const heartbeat = setInterval(() => {
    beat(deviceWss, "device");
    beat(phoneWss, "phone");
  }, opts.heartbeatMs ?? HEARTBEAT.pingEveryMs);
  heartbeat.unref();

  const reject = (socket: Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    const path = (req.url ?? "").split("?")[0];
    if (path === "/device") {
      deviceWss.handleUpgrade(req, socket, head, (ws) => deviceWss.emit("connection", ws, req));
    } else if (path === "/phone") {
      const origin = req.headers.origin;
      if (!origin || !allowed.has(origin)) {
        ev("phone origin rejected");
        return reject(socket, 403, "Forbidden");
      }
      phoneWss.handleUpgrade(req, socket, head, (ws) => phoneWss.emit("connection", ws, req));
    } else {
      reject(socket, 404, "Not Found");
    }
  });

  return {
    server,
    listen(port, host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      });
    },
    async close() {
      clearInterval(heartbeat);
      for (const u of units.values()) {
        if (u.scanTimer) clearTimeout(u.scanTimer);
        dropCode(u);
      }
      for (const c of [...deviceWss.clients, ...phoneWss.clients]) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      deviceWss.close();
      phoneWss.close();
    },
  };
}
