"use client";
// Phone side of the glasses hub (wss://<hub>/phone). Contract: @cpay/glasses-kit/hub (protocol 3).
// The owner token is 32 random bytes made here and kept only on this phone; the hub stores its hash.
// Frames are handed to listeners and never stored.
import {
  HubToPhone,
  OwnerToken,
  PairingCode,
  PhoneToHub,
  LIMITS,
  oled,
  type HubToPhone as HubMsg,
} from "@cpay/glasses-kit/hub";

const TOKEN_KEY = "cpay.ownerToken";
const RECONNECT_MS = 2_000;
/** Refresh scan{on} well inside the hub's 15 s stream cap. */
const SCAN_REFRESH_MS = 5_000;

export type HubConn = "no_hub" | "unpaired" | "connecting" | "connected" | "error";

export interface HubStatus {
  conn: HubConn;
  /** The glasses are connected to the hub right now. */
  online: boolean;
  /** Camera stream state as the hub last reported it. */
  scanning: boolean;
  lastError: string | null;
}

export type FrameMsg = Extract<HubMsg, { type: "frame" }>;
type Listener<T> = (v: T) => void;

export function hubUrl(): string {
  return (process.env.NEXT_PUBLIC_HUB_URL ?? "").replace(/\/$/, "");
}

function randomTokenHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class HubClient {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPair: string | null = null;
  /** New owner token for an in-flight pairing; saved only when the hub says hello (a bad code keeps the old pairing). */
  private pendingToken: string | null = null;
  private closedByUs = false;
  private ticket: { token: string; expMs: number } | null = null;
  private ticketWaiters: Array<(t: string | null) => void> = [];

  status: HubStatus = { conn: "unpaired", online: false, scanning: false, lastError: null };
  private statusL = new Set<Listener<HubStatus>>();
  private frameL = new Set<Listener<FrameMsg>>();
  private scanStateL = new Set<Listener<{ on: boolean; reason: string }>>();

  constructor(private readonly url: string = hubUrl()) {
    if (!url) this.status = { ...this.status, conn: "no_hub" };
  }

  // ------------------------------------------------------------ events
  onStatus(fn: Listener<HubStatus>): () => void {
    this.statusL.add(fn);
    fn(this.status);
    return () => this.statusL.delete(fn);
  }
  onFrame(fn: Listener<FrameMsg>): () => void {
    this.frameL.add(fn);
    return () => this.frameL.delete(fn);
  }
  onScanState(fn: Listener<{ on: boolean; reason: string }>): () => void {
    this.scanStateL.add(fn);
    return () => this.scanStateL.delete(fn);
  }
  private setStatus(p: Partial<HubStatus>): void {
    this.status = { ...this.status, ...p };
    this.statusL.forEach((f) => f(this.status));
  }

  // ------------------------------------------------------------ pairing
  static ownerToken(): string | null {
    if (typeof localStorage === "undefined") return null;
    const t = localStorage.getItem(TOKEN_KEY);
    return t && OwnerToken.safeParse(t).success ? t : null;
  }
  get paired(): boolean {
    return HubClient.ownerToken() !== null;
  }

  /** Claim the glasses showing `code`. Resolves when the hub says hello, rejects on error. */
  pair(rawCode: string): Promise<void> {
    const code = PairingCode.parse(rawCode.trim().toUpperCase());
    if (!this.url) return Promise.reject(new Error("NEXT_PUBLIC_HUB_URL is not set"));
    this.pendingToken = randomTokenHex();
    this.pendingPair = code;
    this.setStatus({ lastError: null });
    this.reconnectNow(); // sets conn "connecting" synchronously, so the listener below never sees a stale state
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Hub didn't answer. Check the glasses are online and try again."));
      }, 15_000);
      const off = this.onStatus((s) => {
        if (s.conn === "connected") {
          clearTimeout(timer);
          off();
          resolve();
        } else if (s.conn === "error" || s.conn === "unpaired" || s.lastError === "Wrong or expired code") {
          clearTimeout(timer);
          off();
          reject(new Error(s.lastError ?? "pairing failed"));
        }
      });
    });
  }

  unpair(): void {
    this.send({ type: "unpair" });
    localStorage.removeItem(TOKEN_KEY);
    this.disconnect();
    this.setStatus({ conn: "unpaired", online: false, scanning: false });
  }

  // ------------------------------------------------------------ connection
  /** Connect if paired (no-op otherwise). Reconnects every 2 s until disconnect(). */
  connect(): void {
    if (!this.url) return this.setStatus({ conn: "no_hub" });
    if (!this.paired) return this.setStatus({ conn: "unpaired" });
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.closedByUs = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    this.stopScanRefresh();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  private reconnectNow(): void {
    this.disconnect();
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    const token = this.pendingPair && this.pendingToken ? this.pendingToken : HubClient.ownerToken();
    if (!token) return this.setStatus({ conn: "unpaired" });
    this.setStatus({ conn: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.url}/phone`);
    } catch (e) {
      this.setStatus({ conn: "error", lastError: e instanceof Error ? e.message : "bad hub url" });
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      const first: PhoneToHub = this.pendingPair
        ? { type: "pair", code: this.pendingPair, ownerToken: token }
        : { type: "auth", ownerToken: token };
      this.raw(first);
    };
    ws.onmessage = (e) => this.handle(e.data);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.stopScanRefresh();
      this.setStatus({ online: false, scanning: false, conn: this.status.conn === "unpaired" ? "unpaired" : "connecting" });
      this.scheduleReconnect();
    };
    ws.onerror = () => undefined; // onclose follows
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || !this.paired) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closedByUs) this.open();
    }, RECONNECT_MS);
  }

  private handle(data: unknown): void {
    if (typeof data !== "string" || data.length > LIMITS.frameMaxBytes * 2) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = HubToPhone.safeParse(json);
    if (!parsed.success) return;
    const m = parsed.data;
    switch (m.type) {
      case "hello":
        if (this.pendingPair && this.pendingToken) localStorage.setItem(TOKEN_KEY, this.pendingToken);
        this.pendingPair = null;
        this.pendingToken = null;
        this.setStatus({ conn: "connected", online: m.online, lastError: null });
        this.raw({ type: "ticket_request" });
        break;
      case "device_status":
        this.setStatus({ online: m.online, ...(m.online ? {} : { scanning: false }) });
        break;
      case "frame":
        this.frameL.forEach((f) => f(m));
        break;
      case "scan_state":
        this.setStatus({ scanning: m.on });
        if (!m.on) this.stopScanRefresh();
        this.scanStateL.forEach((f) => f({ on: m.on, reason: m.reason }));
        break;
      case "ticket": {
        // exp may be seconds or ms; normalise to ms.
        const expMs = m.exp < 1e12 ? m.exp * 1000 : m.exp;
        this.ticket = { token: m.token, expMs };
        this.ticketWaiters.splice(0).forEach((w) => w(m.token));
        break;
      }
      case "error":
        if (m.code === "bad_code") {
          // Wrong/expired code: drop only the in-flight pairing; an existing pairing stays and reconnects.
          this.pendingPair = null;
          this.pendingToken = null;
          this.ws?.close();
          this.setStatus({ conn: this.paired ? "connecting" : "unpaired", online: false, lastError: "Wrong or expired code" });
        } else if (m.code === "unauthorized") {
          // The hub doesn't know our token any more (unpaired elsewhere): forget it so we stop retrying.
          localStorage.removeItem(TOKEN_KEY);
          this.closedByUs = true;
          this.ws?.close();
          this.setStatus({ conn: "unpaired", online: false, lastError: "Glasses not paired" });
        } else {
          this.setStatus({ lastError: m.code });
        }
        break;
    }
  }

  // ------------------------------------------------------------ commands
  private raw(m: PhoneToHub): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(PhoneToHub.parse(m)));
    return true;
  }
  private send(m: PhoneToHub): boolean {
    if (this.status.conn !== "connected") return false;
    return this.raw(m);
  }

  /** Camera on/off. While on, scan{on} is re-sent every 5 s (the hub stops a stream after 15 s without it). */
  scan(on: boolean): boolean {
    this.stopScanRefresh();
    const ok = this.send({ type: "scan", on });
    if (on && ok) this.scanTimer = setInterval(() => this.send({ type: "scan", on: true }), SCAN_REFRESH_MS);
    return ok;
  }
  private stopScanRefresh(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  /** Show text on the glasses OLED (validated: max 4 lines x 21 printable ASCII). */
  setOled(lines: string[]): boolean {
    return this.send({ type: "oled", lines: oled(lines) });
  }

  /** A valid hub ticket for /api/intent and /api/transcribe, fetching a fresh one if needed. */
  async getTicket(timeoutMs = 4_000): Promise<string | null> {
    if (this.ticket && this.ticket.expMs - Date.now() > 10_000) return this.ticket.token;
    if (!this.send({ type: "ticket_request" })) return null;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.ticketWaiters = this.ticketWaiters.filter((w) => w !== done);
        resolve(null);
      }, timeoutMs);
      const done = (tok: string | null) => {
        clearTimeout(t);
        resolve(tok);
      };
      this.ticketWaiters.push(done);
    });
  }
}

let singleton: HubClient | null = null;
/** One hub connection per tab, shared by every page. */
export function getHub(): HubClient {
  if (!singleton) singleton = new HubClient();
  return singleton;
}
