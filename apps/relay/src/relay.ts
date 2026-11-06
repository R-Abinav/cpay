// Stateless WebSocket relay. Routes ciphertext between payers and recipients; persists nothing.
// Never logs payloads, IPs or peer identities.
//
// Recipients must prove they hold a World ID card before anyone can probe them: the relay sends a fresh
// {type:"challenge", nonce} on every connection, and recipient.hello carries a BBS presentation bound to
// relayHelloDigest(nonce, pub), verified against the issuer's public key. An unverified connection is never
// registered (no peerId, never listed, never probed, gets no QR quotes either: a QR quote's claim needs the
// same card anyway, so there is nothing to gain by letting it in).
import { randomBytes, randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
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
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxSessionsPerPayer: 4,
  probesPerMinutePerPayer: 3,
  probesPerMinutePerRecipient: 30,
};

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
  stats(): { recipients: number; sessions: number; refusedHellos: number; rateLimited: number };
}

const MINUTE = 60_000;

function send(ws: WebSocket, msg: RelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function fail(ws: WebSocket, message: string): void {
  send(ws, { type: "error", message });
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
  const wss = opts.server
    ? new WebSocketServer({ server: opts.server, maxPayload: MAX_PAYLOAD_BYTES })
    : new WebSocketServer({ port: opts.port ?? 8787, host: opts.host, maxPayload: MAX_PAYLOAD_BYTES });

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
  const counters = { refusedHellos: 0, rateLimited: 0 };

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

  wss.on("connection", (ws) => {
    const conn: Conn = { ws, role: "none", challenge: randomBytes(32).toString("hex"), deliveries: [], sessions: new Set(), probes: [] };
    send(ws, { type: "challenge", nonce: conn.challenge! });

    ws.on("message", (data, isBinary) => {
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
      if (conn.peerId) recipients.delete(conn.peerId);
      for (const id of [...conn.sessions]) dropSession(id);
    });
    ws.on("error", () => ws.terminate());
  });

  const ready = new Promise<number>((resolve, reject) => {
    const done = () => {
      const a = (opts.server ?? wss).address();
      resolve(typeof a === "object" && a ? a.port : 0);
    };
    if (opts.server) return opts.server.listening ? done() : opts.server.once("listening", done);
    wss.once("listening", done);
    wss.once("error", reject);
  });

  return {
    wss,
    ready,
    stats: () => ({ recipients: recipients.size, sessions: sessions.size, ...counters }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const id of [...sessions.keys()]) dropSession(id);
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
