"use client";
// Client for the glasses bridge (packages/glasses-kit). Schemas + OLED screens come from @cpay/glasses-kit;
// we never hand-write OLED strings.
import { BridgeToWeb, oledStates, parseJson, type DeviceStatus, type OledMessage, type WebToBridge } from "@cpay/glasses-kit";

export { oledStates };
export type { BridgeToWeb, DeviceStatus, OledMessage };

export type BridgeState = "connecting" | "open" | "closed" | "not_configured";

export interface BridgeCallbacks {
  onMessage: (msg: BridgeToWeb) => void;
  onState: (s: BridgeState, detail?: string) => void;
}

const RETRY_MS = 2000;

export class BridgeConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private lastOled: OledMessage | null = null;

  constructor(
    private readonly url: string,
    private readonly cb: BridgeCallbacks,
  ) {}

  start(): void {
    this.stopped = false;
    if (!this.url) return this.cb.onState("not_configured", "NEXT_PUBLIC_BRIDGE_WS_URL is not set");
    this.open();
  }

  private open(): void {
    this.cb.onState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.cb.onState("closed", (e as Error).message);
      return this.schedule();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.cb.onState("open");
      // Replay the current screen after a reconnect.
      if (this.lastOled) this.send(this.lastOled);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.cb.onState("closed", "bridge not reachable");
      this.schedule();
    };
    ws.onerror = () => undefined;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseJson(BridgeToWeb, ev.data);
      if (msg) this.cb.onMessage(msg);
    };
  }

  private schedule(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.open();
    }, RETRY_MS);
  }

  send(msg: WebToBridge): boolean {
    if (msg.type === "oled") this.lastOled = msg;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  oled(msg: OledMessage): void {
    this.send(msg);
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close();
    this.ws = null;
  }
}
