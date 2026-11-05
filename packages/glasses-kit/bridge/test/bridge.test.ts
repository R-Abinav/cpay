// Routing tests with fake device sockets (TEST FIXTURES, inside tests only).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type Bridge, type Logger, createBridge } from "../src/bridge.js";
import { BridgeToWeb } from "../src/messages.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

class Client {
  readonly ws: WebSocket;
  readonly inbox: unknown[] = [];
  readonly binInbox: Buffer[] = [];
  private waiters: Array<() => void> = [];
  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, headers ? { headers } : undefined);
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) this.binInbox.push(data as Buffer);
      else this.inbox.push(JSON.parse(data.toString()));
      for (const w of this.waiters.splice(0)) w();
    });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }
  async next<T = unknown>(pred: (m: any) => boolean, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as T;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout; inbox=${JSON.stringify(this.inbox)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
  send(obj: unknown) {
    this.ws.send(JSON.stringify(obj));
  }
  close() {
    this.ws.close();
  }
}

const logs: string[] = [];
const logger: Logger = { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) };

let bridge: Bridge;
let dev: string;
let web: string;
const clients: Client[] = [];

async function client(url: string, headers?: Record<string, string>) {
  const c = new Client(url, headers);
  clients.push(c);
  await c.open();
  return c;
}

beforeEach(async () => {
  logs.length = 0;
  bridge = createBridge({ httpPort: 0, wsPort: 0, deviceHost: "127.0.0.1", frameTimeoutMs: 300, logger });
  const p = await bridge.start();
  dev = `ws://127.0.0.1:${p.httpPort}`;
  web = `ws://127.0.0.1:${p.wsPort}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await bridge.stop();
});

describe("bridge routing", () => {
  it("greets the web app with device status", async () => {
    const app = await client(web);
    const hello = await app.next((m) => m.type === "hello");
    expect(BridgeToWeb.parse(hello)).toEqual({ type: "hello", protocol: 1, devices: { c3: false, cam: false } });
  });

  it("reports devices coming online", async () => {
    const app = await client(web);
    await client(`${dev}/c3`);
    expect(await app.next((m) => m.type === "device_status" && m.devices.c3)).toMatchObject({
      devices: { c3: true, cam: false },
    });
  });

  it("forwards button events to the web app", async () => {
    const app = await client(web);
    const c3 = await client(`${dev}/c3`);
    c3.send({ t: "btn", e: "confirm" });
    const m = await app.next((m) => m.type === "button");
    expect(m).toMatchObject({ type: "button", event: "confirm" });
  });

  it("on capture_down: forwards the button, fetches a frame from the CAM, forwards it as base64", async () => {
    const app = await client(web);
    const cam = await client(`${dev}/cam`);
    const c3 = await client(`${dev}/c3`);
    c3.send({ t: "btn", e: "capture_down" });
    expect(await app.next((m) => m.type === "button")).toMatchObject({ event: "capture_down" });
    const req = await cam.next<{ t: string; id: number }>((m) => m.t === "capture");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(req.id);
    cam.ws.send(Buffer.concat([header, JPEG]));
    const frame = BridgeToWeb.parse(await app.next((m) => m.type === "frame"));
    expect(frame).toMatchObject({ type: "frame", id: req.id, mime: "image/jpeg", bytes: JPEG.length });
    if (frame.type !== "frame") throw new Error("unreachable");
    expect(Buffer.from(frame.dataBase64, "base64").equals(JPEG)).toBe(true);
    // logs carry metadata only, never image data
    const b64 = JPEG.toString("base64");
    expect(logs.some((l) => l.includes(b64))).toBe(false);
    expect(logs.some((l) => l.includes(`frame ${req.id} forwarded`))).toBe(true);
  });

  it("reports cam_offline when there is no CAM", async () => {
    const app = await client(web);
    const c3 = await client(`${dev}/c3`);
    c3.send({ t: "btn", e: "capture_down" });
    expect(await app.next((m) => m.type === "frame_error")).toMatchObject({ reason: "cam_offline" });
  });

  it("times out if the CAM never answers, and drops a late frame", async () => {
    const app = await client(web);
    const cam = await client(`${dev}/cam`);
    app.send({ type: "capture_request" });
    const req = await cam.next<{ id: number }>((m) => m.t === "capture");
    expect(await app.next((m) => m.type === "frame_error")).toMatchObject({ id: req.id, reason: "timeout" });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(req.id);
    cam.ws.send(Buffer.concat([header, JPEG]));
    await new Promise((r) => setTimeout(r, 100));
    expect(app.inbox.some((m: any) => m.type === "frame")).toBe(false);
  });

  it("forwards CAM capture errors", async () => {
    const app = await client(web);
    const cam = await client(`${dev}/cam`);
    app.send({ type: "capture_request" });
    const req = await cam.next<{ id: number }>((m) => m.t === "capture");
    cam.send({ t: "capture_error", id: req.id, reason: "fb_get_failed" });
    expect(await app.next((m) => m.type === "frame_error")).toMatchObject({
      id: req.id,
      reason: "camera_error",
      detail: "fb_get_failed",
    });
  });

  it("rejects a non-JPEG frame", async () => {
    const app = await client(web);
    const cam = await client(`${dev}/cam`);
    app.send({ type: "capture_request" });
    const req = await cam.next<{ id: number }>((m) => m.t === "capture");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(req.id);
    cam.ws.send(Buffer.concat([header, Buffer.from("not a jpeg")]));
    expect(await app.next((m) => m.type === "frame_error")).toMatchObject({ reason: "bad_frame" });
  });

  it("pushes OLED lines to the C3, and replays them when the C3 reconnects", async () => {
    const app = await client(web);
    app.send({ type: "oled", lines: ["VERIFIED HUMAN", "2 USDC", "OK?"] });
    await new Promise((r) => setTimeout(r, 50));
    const c3 = await client(`${dev}/c3`);
    expect(await c3.next((m) => m.t === "oled")).toEqual({ t: "oled", lines: ["VERIFIED HUMAN", "2 USDC", "OK?"] });
    app.send({ type: "oled", lines: ["PAID"] });
    expect(await c3.next((m) => m.t === "oled")).toEqual({ t: "oled", lines: ["PAID"] });
  });

  it("shows NO APP on the OLED when the last web client leaves", async () => {
    const c3 = await client(`${dev}/c3`);
    expect(await c3.next((m) => m.t === "oled")).toEqual({ t: "oled", lines: ["NO APP"] });
    const app = await client(web);
    app.send({ type: "oled", lines: ["READY"] });
    expect(await c3.next((m) => m.t === "oled")).toEqual({ t: "oled", lines: ["READY"] });
    app.close();
    expect(await c3.next((m) => m.t === "oled")).toEqual({ t: "oled", lines: ["NO APP"] });
  });

  it("answers invalid web messages with an error and does not forward them", async () => {
    const app = await client(web);
    const c3 = await client(`${dev}/c3`);
    await c3.next((m) => m.t === "oled"); // initial NO APP
    app.send({ type: "oled", lines: ["x".repeat(40)] });
    expect(await app.next((m) => m.type === "error")).toMatchObject({ reason: "invalid message" });
    await new Promise((r) => setTimeout(r, 50));
    expect(c3.inbox).toHaveLength(0);
  });

  it("ignores invalid device messages", async () => {
    const app = await client(web);
    const c3 = await client(`${dev}/c3`);
    c3.send({ t: "btn", e: "pay_everything" });
    c3.ws.send("{nope");
    await new Promise((r) => setTimeout(r, 50));
    expect(app.inbox.some((m: any) => m.type === "button")).toBe(false);
  });

  it("rejects web clients from foreign origins", async () => {
    await expect(client(web, { Origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(client(web, { Origin: "http://localhost:3000" })).resolves.toBeDefined();
  });

  it("rejects unknown device paths", async () => {
    await expect(client(`${dev}/toaster`)).rejects.toThrow(/404/);
  });
});

describe("device token", () => {
  it("requires the token when configured", async () => {
    const b = createBridge({ httpPort: 0, wsPort: 0, deviceHost: "127.0.0.1", deviceToken: "s3cret", logger });
    const p = await b.start();
    try {
      await expect(client(`ws://127.0.0.1:${p.httpPort}/c3`)).rejects.toThrow(/401/);
      await expect(client(`ws://127.0.0.1:${p.httpPort}/c3?token=wrong!`)).rejects.toThrow(/401/);
      await expect(client(`ws://127.0.0.1:${p.httpPort}/c3?token=s3cret`)).resolves.toBeDefined();
    } finally {
      for (const c of clients.splice(0)) c.close();
      await b.stop();
    }
  });
});
