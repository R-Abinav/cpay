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
  PAIRING_CODE_ALPHABET,
  PHONE_CLOSE_UNPAIRED,
  oled,
  type HubToPhone as HubMsg,
  type UnpairReason,
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
  /** Why this phone's last pairing ended (hub close 4003 or an unknown token); cleared by the next hello. */
  ended: UnpairReason | null;
}

/**
 * The one glasses state every screen shows (minimal and accurate):
 *   no_hub     this build has no hub URL
 *   unpaired   no pairing on this phone: show the code input
 *   restarted  our pairing ended because the glasses powered on again: show the code input for the new code
 *   offline    paired, but the glasses aren't connected to the hub right now (or we can't reach the hub)
 *   paired     paired and the glasses are online (heartbeat-checked by the hub)
 * An unpaired phone can't see whether the glasses are on (the hub tells only the paired phone), so it never claims they are.
 */
export type GlassesState = "no_hub" | "unpaired" | "restarted" | "offline" | "paired";
export function glassesState(s: HubStatus): GlassesState {
  if (s.conn === "no_hub") return "no_hub";
  if (s.conn === "unpaired") return s.ended === "glasses_restarted" ? "restarted" : "unpaired";
  return s.conn === "connected" && s.online ? "paired" : "offline";
}
export const GLASSES_TEXT: Record<GlassesState, string> = {
  no_hub: "Hub not configured",
  unpaired: "Turn on your glasses and enter the code shown on them",
  restarted: "Glasses restarted — enter the new code",
  offline: "Glasses offline",
  paired: "Paired",
};

const CODE_CHARS = new Set(PAIRING_CODE_ALPHABET.split(""));
/** Keeps only pairing-code characters (uppercased), max 6. */
export function cleanPairCode(raw: string): string {
  return raw
    .toUpperCase()
    .split("")
    .filter((c) => CODE_CHARS.has(c))
    .join("")
    .slice(0, 6);
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

  status: HubStatus = { conn: "unpaired", online: false, scanning: false, lastError: null, ended: null };
  private statusL = new Set<Listener<HubStatus>>();
  private frameL = new Set<Listener<FrameMsg>>();
  private scanStateL = new Set<Listener<{ on: boolean; reason: string }>>();
  private hiddenAt = 0;

  constructor(private readonly url: string = hubUrl()) {
    if (!url) this.status = { ...this.status, conn: "no_hub" };
    if (typeof window === "undefined" || !url) return;
    // A phone that slept or lost its network may hold a dead socket that still looks open (browsers can't see the
    // hub's pings), so "Glasses online" could go stale. Re-check with a fresh connection when we come back.
    window.addEventListener("offline", () => {
      if (this.status.conn !== "unpaired") this.setStatus({ online: false, scanning: false });
    });
    window.addEventListener("online", () => this.refresh());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.hiddenAt = Date.now();
      else if (this.hiddenAt && Date.now() - this.hiddenAt > 5_000) this.refresh();
    });
    // Another tab paired or lost the pairing: follow it (the token lives in localStorage, shared by tabs).
    window.addEventListener("storage", (e) => {
      if (e.key !== TOKEN_KEY) return;
      if (this.paired) this.refresh();
      else if (!this.pendingPair) {
        this.disconnect();
        this.setStatus({ conn: "unpaired", online: false, scanning: false });
      }
    });
  }

  /** Reconnect now if paired and not mid-pairing or mid-scan (a fresh hello re-reads the glasses' online state). */
  private refresh(): void {
    if (!this.paired || this.pendingPair || this.status.scanning) return;
    this.reconnectNow();
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
        // Give up this pairing attempt (no endless retries with a code that may be gone).
        this.pendingPair = null;
        this.pendingToken = null;
        if (!this.paired) {
          this.disconnect();
          this.setStatus({ conn: "unpaired", online: false });
        } else this.reconnectNow();
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
          this.pendingPair = null;
          this.pendingToken = null;
          reject(new Error(s.lastError ?? "pairing failed"));
        }
      });
    });
  }

  unpair(): void {
    this.send({ type: "unpair" });
    localStorage.removeItem(TOKEN_KEY);
    this.disconnect();
    this.setStatus({ conn: "unpaired", online: false, scanning: false, lastError: null, ended: null });
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
    ws.onmessage = (e) => {
      if (this.ws === ws) this.handle(e.data); // ignore a replaced socket's late messages
    };
    ws.onclose = (e) => {
      // A socket we already replaced (reconnectNow) must not touch the state or schedule another socket.
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopScanRefresh();
      if (e.code === PHONE_CLOSE_UNPAIRED) {
        // The hub ended our pairing: the glasses restarted (every power-on starts unpaired) or Unpair elsewhere.
        return e.reason === "glasses_restarted"
          ? this.forgetPairing("glasses_restarted", null)
          : this.forgetPairing("unpaired", "Glasses unpaired — enter the code shown on your glasses");
      }
      this.setStatus({ online: false, scanning: false, conn: this.status.conn === "unpaired" ? "unpaired" : "connecting" });
      this.scheduleReconnect();
    };
    ws.onerror = () => undefined; // onclose follows
  }

  /** Our pairing is gone on the hub: drop the token and stop reconnecting until the user pairs again. */
  private forgetPairing(ended: UnpairReason, message: string | null): void {
    localStorage.removeItem(TOKEN_KEY);
    this.ticket = null;
    this.disconnect();
    this.setStatus({ conn: "unpaired", online: false, scanning: false, lastError: message, ended });
  }

  private scheduleReconnect(): void {
    // Retry with our token, or an in-flight pairing (the hub keeps the code valid when its database blipped).
    if (this.closedByUs || (!this.paired && !this.pendingPair)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closedByUs && !this.ws) this.open();
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
        this.setStatus({ conn: "connected", online: m.online, lastError: null, ended: null });
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
          // The hub doesn't know our token any more: almost always the glasses powered on again while this phone
          // was away (every power-on unpairs), else Unpair elsewhere. Forget it so we stop retrying a dead token.
          this.forgetPairing("glasses_restarted", null);
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
