// Stateless WebSocket relay. Routes ciphertext between payers and recipients; persists nothing.
// Never logs payloads, IPs or peer identities.
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientMessage,
  MAX_PAYLOAD_BYTES,
  MAX_PROBE_ITEMS,
  type RelayMessage,
} from "@cpay/protocol";

export interface RelayOptions {
  /** listen on this port (0 = random); ignored if `server` is given */
  port?: number;
  host?: string;
  server?: HttpServer;
  /** open sessions a single payer connection may hold */
  maxSessionsPerPayer?: number;
  /** sessions are forgotten after this long */
  sessionTtlMs?: number;
}

interface Conn {
  ws: WebSocket;
  role: "none" | "recipient" | "payer";
  /** recipient only: random id assigned by the relay for this connection */
  peerId?: string;
  pub?: string;
  /** payer only */
  sessions: Set<string>;
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
  stats(): { recipients: number; sessions: number };
}

function send(ws: WebSocket, msg: RelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function fail(ws: WebSocket, message: string): void {
  send(ws, { type: "error", message });
}

export function createRelay(opts: RelayOptions = {}): Relay {
  const maxSessions = opts.maxSessionsPerPayer ?? 4;
  const ttl = opts.sessionTtlMs ?? 60_000;
  const wss = opts.server
    ? new WebSocketServer({ server: opts.server, maxPayload: MAX_PAYLOAD_BYTES })
    : new WebSocketServer({ port: opts.port ?? 8787, host: opts.host, maxPayload: MAX_PAYLOAD_BYTES });

  const recipients = new Map<string, Conn>();
  const sessions = new Map<string, Session>();

  const dropSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    s.payer.sessions.delete(id);
    sessions.delete(id);
  };

  wss.on("connection", (ws) => {
    const conn: Conn = { ws, role: "none", sessions: new Set() };

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
          if (conn.role !== "none") return fail(ws, "already registered");
          conn.role = "recipient";
          conn.peerId = randomUUID();
          conn.pub = msg.pub;
          recipients.set(conn.peerId, conn);
          return;
        }
        case "payer.hello": {
          if (conn.role === "recipient") return fail(ws, "recipients cannot pay on this connection");
          conn.role = "payer";
          const peers = [...recipients.values()]
            .slice(-MAX_PROBE_ITEMS)
            .map((r) => ({ peerId: r.peerId!, pub: r.pub! }));
          return send(ws, { type: "peers", peers });
        }
        case "probe": {
          if (conn.role !== "payer") return fail(ws, "send payer.hello first");
          if (sessions.has(msg.sessionId)) return fail(ws, "session exists");
          if (conn.sessions.size >= maxSessions) return fail(ws, "too many open sessions");
          const pending = new Set<string>();
          const timer = setTimeout(() => dropSession(msg.sessionId), ttl);
          timer.unref();
          sessions.set(msg.sessionId, { payer: conn, pending, timer });
          conn.sessions.add(msg.sessionId);
          for (const item of msg.items) {
            const r = recipients.get(item.peerId);
            if (!r || pending.has(item.peerId)) continue;
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
    stats: () => ({ recipients: recipients.size, sessions: sessions.size }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const id of [...sessions.keys()]) dropSession(id);
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
