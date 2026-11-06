// Stateless WebSocket relay. Routes ciphertext between payers and recipients; persists nothing.
// Never logs payloads, IPs or peer identities.
//
// Recipients must prove they hold a World ID card before anyone can probe them: the relay sends a fresh
// {type:"challenge", nonce} on every connection, and recipient.hello carries a BBS presentation bound to
// relayHelloDigest(nonce, pub), verified against the issuer's public key. An unverified connection is never
// registered (no peerId, never listed, never probed, gets no QR quotes either: a QR quote's claim needs the
// same card anyway, so there is nothing to gain by letting it in).
//
// Connection caps per client IP (open sockets + new connections per minute) live only in memory as counters;
// an IP is never logged or stored, and its entry is deleted as soon as its counts reach zero.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { currentEpoch, verifyProof } from "@cpay/credential";
import {
  ClientMessage,
  MAX_PAYLOAD_BYTES,
  MAX_PROBE_ITEMS,
  relayHelloDigest,
  type RelayMessage,
} from "@cpay/protocol";

export interface RelayLimits {
  /** open sessions a single payer connection may hold */
  maxSessionsPerPayer: number;
  /** probe sessions a single payer connection may start per minute */
  probesPerMinutePerPayer: number;
  /** probes delivered to one recipient per minute, from all payers together (backstop against reconnecting payers) */
  probesPerMinutePerRecipient: number;
  /** open connections from one client IP (a whole venue may share one NAT IP, so this is generous) */
  maxConnsPerIp: number;
  /** new connections from one client IP per minute (sliding window) */
  newConnsPerMinutePerIp: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxSessionsPerPayer: 4,
  probesPerMinutePerPayer: 3,
  probesPerMinutePerRecipient: 30,
  maxConnsPerIp: 20,
  newConnsPerMinutePerIp: 60,
};

/** Close code for a connection refused by the per-IP caps. */
export const CLOSE_TOO_MANY_CONNECTIONS = 4029;

/** Ping every socket this often; terminate one that misses HEARTBEAT_MAX_MISSED pongs in a row. */
export const HEARTBEAT_MS = 5_000;
export const HEARTBEAT_MAX_MISSED = 2;

export interface RelayOptions {
  /** listen on this port (0 = random); ignored if `server` is given */
  port?: number;
  host?: string;
  server?: HttpServer;
  /** @deprecated use limits.maxSessionsPerPayer */
  maxSessionsPerPayer?: number;
  limits?: Partial<RelayLimits>;
  /** sessions are forgotten after this long */
  sessionTtlMs?: number;
  /**
   * The issuer's BBS public key (base64), or a function resolving it. Without it every recipient.hello is refused:
   * the relay never registers a recipient it can't verify.
   */
  issuerPublicKey?: string | (() => Promise<string>);
  /** injectable clock (tests) */
  now?: () => number;
  /**
   * Behind a proxy that appends the client IP to X-Forwarded-For (Render): take the right-most entry.
   * Off by default (locally the socket address is used; a client could forge the header).
   */
  trustProxy?: boolean;
  /** heartbeat ping interval; defaults to HEARTBEAT_MS */
  heartbeatMs?: number;
}

interface Conn {
  ws: WebSocket;
  role: "none" | "verifying" | "recipient" | "payer";
  /** fresh per connection, single use */
  challenge: string | null;
  /** recipient only: random id assigned by the relay for this connection */
  peerId?: string;
  pub?: string;
  /** recipient only: delivery times in the last minute */
  deliveries: number[];
  /** payer only */
  sessions: Set<string>;
  /** payer only: probe start times in the last minute */
  probes: number[];
}

interface Session {
  payer: Conn;
  /** peers this session probed that haven't answered yet (one claim each) */
  pending: Set<string>;
  timer: NodeJS.Timeout;
}

export interface Relay {
  wss: WebSocketServer;
  /** resolves once listening; the bound port */
  ready: Promise<number>;
  close(): Promise<void>;
  /** counts only, for tests */
  stats(): {
    recipients: number;
    sessions: number;
    refusedHellos: number;
    rateLimited: number;
    refusedConnections: number;
    /** distinct client IPs currently tracked (a count only, never the IPs) */
    trackedIps: number;
  };
}

const MINUTE = 60_000;

function send(ws: WebSocket, msg: RelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function fail(ws: WebSocket, message: string): void {
  send(ws, { type: "error", message });
}

/**
 * The client IP used for the per-IP caps. Behind a trusted proxy: the right-most X-Forwarded-For entry (the one the
 * proxy appended; entries to its left are client-controlled). Otherwise the socket address. Never logged.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const h = req.headers["x-forwarded-for"];
    const raw = Array.isArray(h) ? h.join(",") : (h ?? "");
    const last = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Keep only timestamps inside the last minute; returns how many remain. */
function windowCount(list: number[], now: number): number {
  while (list.length > 0 && now - list[0]! >= MINUTE) list.shift();
  return list.length;
}

export function createRelay(opts: RelayOptions = {}): Relay {
  const limits: RelayLimits = {
    ...DEFAULT_RELAY_LIMITS,
    ...(opts.maxSessionsPerPayer !== undefined ? { maxSessionsPerPayer: opts.maxSessionsPerPayer } : {}),
    ...opts.limits,
  };
  const ttl = opts.sessionTtlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  // Without an external server we own a small HTTP server: GET /health for Render, everything else 404.
  const http =
    opts.server ??
    createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  const ownsHttp = !opts.server;
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD_BYTES });
  const trustProxy = opts.trustProxy ?? false;

  // Per-IP counters, memory only. Entries are deleted when they reach zero.
  const openByIp = new Map<string, number>();
  const newByIp = new Map<string, number[]>();

  let issuerKey: Promise<string> | null = null;
  const issuerPublicKey = (): Promise<string> => {
    const k = opts.issuerPublicKey;
    if (!k) return Promise.reject(new Error("no issuer key"));
    if (typeof k === "string") return Promise.resolve(k);
    issuerKey ??= k().catch((e: unknown) => {
      issuerKey = null; // retry on the next hello
      throw e;
    });
    return issuerKey;
  };

  const recipients = new Map<string, Conn>();
  const sessions = new Map<string, Session>();
  const counters = { refusedHellos: 0, rateLimited: 0, refusedConnections: 0 };

  /** Admit a new connection from `ip` under both caps, or refuse it. Only admitted connections are counted. */
  const admit = (ip: string): boolean => {
    if ((openByIp.get(ip) ?? 0) >= limits.maxConnsPerIp) return false;
    const t = now();
    const recent = newByIp.get(ip) ?? [];
    if (windowCount(recent, t) >= limits.newConnsPerMinutePerIp) return false;
    recent.push(t);
    newByIp.set(ip, recent);
    openByIp.set(ip, (openByIp.get(ip) ?? 0) + 1);
    return true;
  };
  const release = (ip: string) => {
    const n = (openByIp.get(ip) ?? 1) - 1;
    if (n <= 0) openByIp.delete(ip);
    else openByIp.set(ip, n);
  };
  const sweepWindows = () => {
    const t = now();
    for (const [ip, list] of newByIp) if (windowCount(list, t) === 0) newByIp.delete(ip);
  };

  // Heartbeat: a phone that drops off the network doesn't close TCP, so ping every socket and terminate one that
  // stops answering (terminate() runs the normal close handler: recipient unlisted, sessions dropped).
  const missed = new WeakMap<WebSocket, number>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const n = missed.get(ws) ?? 0;
      if (n >= HEARTBEAT_MAX_MISSED) {
        ws.terminate();
        continue;
      }
      missed.set(ws, n + 1);
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
    sweepWindows();
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  const dropSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    s.payer.sessions.delete(id);
    sessions.delete(id);
  };

  /** Verify the BBS presentation bound to this connection's challenge + pub. Never throws. */
  async function verifiedHuman(challenge: string, pub: string, proof: string): Promise<boolean> {
    try {
      const key = await issuerPublicKey();
      const revealed = await verifyProof(proof, key, relayHelloDigest(challenge, pub.toLowerCase()));
      return revealed.epoch === currentEpoch(new Date(now()));
    } catch {
      return false;
    }
  }

  wss.on("connection", (ws, req) => {
    const ip = clientIp(req, trustProxy);
    if (!admit(ip)) {
      counters.refusedConnections++;
      ws.close(CLOSE_TOO_MANY_CONNECTIONS, "too_many_connections");
      return;
    }
    missed.set(ws, 0);
    const alive = () => missed.set(ws, 0);
    ws.on("pong", alive);

    const conn: Conn = { ws, role: "none", challenge: randomBytes(32).toString("hex"), deliveries: [], sessions: new Set(), probes: [] };
    send(ws, { type: "challenge", nonce: conn.challenge! });

    ws.on("message", (data, isBinary) => {
      alive();
      if (isBinary) return fail(ws, "text frames only");
      let parsed;
      try {
        parsed = ClientMessage.safeParse(JSON.parse(data.toString("utf8")));
      } catch {
        return fail(ws, "bad message");
      }
      if (!parsed.success) return fail(ws, "bad message");
      const msg = parsed.data;

      switch (msg.type) {
        case "recipient.hello": {
          if (conn.role !== "none" || !conn.challenge) return fail(ws, "already registered");
          // One attempt per connection: the challenge is spent whatever the outcome.
          const challenge = conn.challenge;
          conn.challenge = null;
          conn.role = "verifying";
          void verifiedHuman(challenge, msg.pub, msg.proof).then((ok) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!ok) {
              counters.refusedHellos++;
              conn.role = "none";
              fail(ws, "recipient not verified");
              ws.close(4003, "recipient not verified");
              return;
            }
            conn.role = "recipient";
            conn.peerId = randomUUID();
            conn.pub = msg.pub;
            recipients.set(conn.peerId, conn);
            send(ws, { type: "recipient.ready", peerId: conn.peerId });
          });
          return;
        }
        case "payer.hello": {
          if (conn.role === "recipient" || conn.role === "verifying") return fail(ws, "recipients cannot pay on this connection");
          conn.role = "payer";
          conn.challenge = null;
          const peers = [...recipients.values()]
            .slice(-MAX_PROBE_ITEMS)
            .map((r) => ({ peerId: r.peerId!, pub: r.pub! }));
          return send(ws, { type: "peers", peers });
        }
        case "probe": {
          if (conn.role !== "payer") return fail(ws, "send payer.hello first");
          if (sessions.has(msg.sessionId)) return fail(ws, "session exists");
          if (conn.sessions.size >= limits.maxSessionsPerPayer) return fail(ws, "too many open sessions");
          const t = now();
          if (windowCount(conn.probes, t) >= limits.probesPerMinutePerPayer) {
            counters.rateLimited++;
            return fail(ws, "too many probes");
          }
          conn.probes.push(t);
          const pending = new Set<string>();
          const timer = setTimeout(() => dropSession(msg.sessionId), ttl);
          timer.unref();
          sessions.set(msg.sessionId, { payer: conn, pending, timer });
          conn.sessions.add(msg.sessionId);
          for (const item of msg.items) {
            const r = recipients.get(item.peerId);
            if (!r || pending.has(item.peerId)) continue;
            // Per-recipient cap: silently skipped (the payer can't tell a busy phone from a silent one).
            if (windowCount(r.deliveries, t) >= limits.probesPerMinutePerRecipient) {
              counters.rateLimited++;
              continue;
            }
            r.deliveries.push(t);
            pending.add(item.peerId);
            send(r.ws, { type: "probe", sessionId: msg.sessionId, payerPub: msg.payerPub, box: item.box });
          }
          return;
        }
        case "claim": {
          if (conn.role !== "recipient") return fail(ws, "only recipients claim");
          const s = sessions.get(msg.sessionId);
          // Same answer for unknown session and not-probed, so a recipient learns nothing extra.
          if (!s || !s.pending.delete(conn.peerId!)) return fail(ws, "no such session");
          // The payer is not told who sent it; it trial-decrypts.
          return send(s.payer.ws, { type: "claim", sessionId: msg.sessionId, box: msg.box });
        }
      }
    });

    ws.on("close", () => {
      release(ip);
      if (conn.peerId) recipients.delete(conn.peerId);
      for (const id of [...conn.sessions]) dropSession(id);
    });
    ws.on("error", () => ws.terminate());
  });

  const ready = new Promise<number>((resolve, reject) => {
    const done = () => {
      const a = http.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    };
    if (!ownsHttp) return http.listening ? done() : http.once("listening", done);
    http.once("listening", done);
    http.once("error", reject);
    http.listen(opts.port ?? 8787, opts.host);
  });

  return {
    wss,
    ready,
    stats: () => ({
      recipients: recipients.size,
      sessions: sessions.size,
      ...counters,
      trackedIps: new Set([...openByIp.keys(), ...newByIp.keys()]).size,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const id of [...sessions.keys()]) dropSession(id);
        for (const c of wss.clients) c.terminate();
        wss.close(() => {
          if (!ownsHttp) return resolve();
          http.close(() => resolve());
          http.closeAllConnections();
        });
      }),
  };
}
