"use client";
// Thin WebSocket client for apps/relay. Every inbound frame is zod-parsed (RelayMessage); bytes are counted
// so the Privacy X-ray can show what the relay actually saw (sizes + timing, ciphertext only).
import { RelayMessage, type ClientMessage } from "@cpay/protocol";

export type RelayState = "connecting" | "open" | "closed" | "not_configured";

export interface RelayCallbacks {
  onOpen?: () => void;
  onMessage: (msg: RelayMessage) => void;
  onState?: (s: RelayState, detail?: string) => void;
}

export class RelayConnection {
  private ws: WebSocket | null = null;
  bytesSent = 0;
  bytesReceived = 0;

  constructor(
    private readonly url: string,
    private readonly cb: RelayCallbacks,
  ) {}

  connect(): void {
    if (!this.url) {
      this.cb.onState?.("not_configured", "NEXT_PUBLIC_RELAY_URL is not set");
      return;
    }
    if (location.protocol === "https:" && this.url.startsWith("ws://") && !/^ws:\/\/(localhost|127\.0\.0\.1)/.test(this.url)) {
      this.cb.onState?.("closed", "page is HTTPS but relay URL is ws:// (browsers block mixed content): use wss://");
      return;
    }
    this.cb.onState?.("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.cb.onState?.("closed", (e as Error).message);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.cb.onState?.("open");
      this.cb.onOpen?.();
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.cb.onState?.("closed", "relay connection closed");
    };
    ws.onerror = () => undefined;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      this.bytesReceived += ev.data.length;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const parsed = RelayMessage.safeParse(raw);
      if (parsed.success) this.cb.onMessage(parsed.data);
    };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("relay not connected");
    const s = JSON.stringify(msg);
    this.ws.send(s);
    this.bytesSent += s.length;
    return s.length;
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
