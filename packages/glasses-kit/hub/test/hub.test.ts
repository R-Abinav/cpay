import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createHub, type Hub } from "../src/hub.js";
import { DEVICE_AUTH_PREFIX, HEARTBEAT, HubToDevice, HubToPhone, LIMITS, PHONE_CLOSE_UNPAIRED } from "../src/messages.js";
import { MemoryUnitStore } from "../src/store.js";
import { verifyTicket } from "../src/ticket.js";

const SECRET = "t".repeat(48);
const ORIGIN = "https://cpay.test";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(200), Buffer.from([0xff, 0xd9])]);

type Msg = Record<string, unknown>;

/** A ws client that queues parsed JSON messages and lets tests await the next matching one. */
class Client {
  ws: WebSocket;
  msgs: Msg[] = [];
  waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  closed: Promise<number>;
  closeReason = "";
  constructor(url: string, origin?: string, autoPong = true) {
    this.ws = new WebSocket(url, { autoPong, ...(origin ? { origin } : {}) });
    this.ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString()) as Msg;
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.msgs.push(m);
    });
    this.closed = new Promise((r) =>
      this.ws.on("close", (code, reason) => {
        this.closeReason = reason.toString();
        r(code);
      }),
    );
    this.ws.on("error", () => {});
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("unexpected-response", (_req, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
      this.ws.once("error", rej);
    });
  }
  next(pred: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> {
    const i = this.msgs.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m: Msg) => (clearTimeout(t), resolve(m)) };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error("timeout waiting for message"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  /** Resolves true if no matching message arrives within ms. */
  async none(pred: (m: Msg) => boolean, ms = 250) {
    try {
      await this.next(pred, ms);
      return false;
    } catch {
      return true;
    }
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    this.ws.close();
  }
}

const t = (type: string) => (m: Msg) => m.type === type || m.t === type;

function macFor(secretHex: string, nonce: string) {
  const key = createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
  return createHmac("sha256", key).update(DEVICE_AUTH_PREFIX + nonce).digest("hex");
}

let hub: Hub;
let store: MemoryUnitStore;
let base: string;
let logs: string[];
const clients: Client[] = [];

async function startHub(o: { streamMaxMs?: number; pairingCodeTtlSeconds?: number; keepStore?: boolean } = {}) {
  if (!o.keepStore) store = new MemoryUnitStore();
  logs = [];
  hub = createHub({
    store,
    ticketSecret: SECRET,
    ticketTtlSeconds: 600,
    allowedOrigins: [ORIGIN],
    log: (l) => logs.push(l),
    ...o,
  });
  const port = await hub.listen(0, "127.0.0.1");
  base = `ws://127.0.0.1:${port}`;
}

function client(path: string, origin?: string, autoPong = true) {
  const c = new Client(base + path, origin, autoPong);
  clients.push(c);
  return c;
}

type DeviceOpts = { boot?: string; autoPong?: boolean };

/** Connects a device, registers (first time) or authenticates; returns it and its auth_ok. */
async function device(unitId: string, secret = randomBytes(32).toString("hex"), o: DeviceOpts = {}) {
  const d = client("/device", undefined, o.autoPong ?? true);
  await d.open();
  const ch = await d.next(t("challenge"));
  expect(HubToDevice.safeParse(ch).success).toBe(true);
  d.send({ t: "auth", unitId, fw: "test", mac: macFor(secret, ch.nonce as string), ...(o.boot ? { boot: o.boot } : {}) });
  let first = await d.next((m) => m.t === "register" || m.t === "auth_ok");
  if (first.t === "register") {
    d.send({ t: "register", unitId, secret });
    first = await d.next(t("auth_ok"));
  }
  return { d, secret, authOk: first };
}

async function phone(origin = ORIGIN, autoPong = true) {
  const p = client("/phone", origin, autoPong);
  await p.open();
  return p;
}

const token = () => randomBytes(32).toString("hex");
const bootId = () => randomBytes(16).toString("hex");

/** Device + phone paired together. */
async function pairedUnit(unitId: string, o: DeviceOpts = {}) {
  const { d, secret } = await device(unitId, undefined, o);
  const code = (await d.next(t("pair_code"))).code as string;
  const p = await phone();
  const ownerToken = token();
  p.send({ type: "pair", code, ownerToken });
  const hello = await p.next(t("hello"));
  expect(hello).toEqual({ type: "hello", protocol: 3, online: true });
  await d.next(t("paired"));
  return { d, p, ownerToken, secret, code };
}

beforeEach(async () => {
  await startHub();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await hub.close();
});

describe("health", () => {
  it("GET /health returns only ok", async () => {
    const res = await fetch(base.replace("ws:", "http:") + "/health");
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("device auth", () => {
  it("registers on first contact, then authenticates with the stored hash", async () => {
    const { d, secret } = await device("unit-a");
    const pc = await d.next(t("pair_code"));
    expect(pc.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect((await store.getUnit("unit-a"))?.unitSecretHash).toBe(
      createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex"),
    );
    d.close();
    await d.closed;
    // Second connection: known unit, no register step.
    const d2 = client("/device");
    await d2.open();
    const ch = await d2.next(t("challenge"));
    d2.send({ t: "auth", unitId: "unit-a", fw: "test", mac: macFor(secret, ch.nonce as string) });
    expect(await d2.next(t("auth_ok"))).toEqual({ t: "auth_ok", paired: false });
  });

  it("rejects a bad MAC for a known unit", async () => {
    const { d } = await device("unit-b");
    d.close();
    const d2 = client("/device");
    await d2.open();
    const ch = await d2.next(t("challenge"));
    d2.send({ t: "auth", unitId: "unit-b", fw: "test", mac: macFor(randomBytes(32).toString("hex"), ch.nonce as string) });
    expect(await d2.closed).toBe(4001);
  });

  it("rejects a register whose secret does not match the auth MAC", async () => {
    const d = client("/device");
    await d.open();
    const ch = await d.next(t("challenge"));
    d.send({ t: "auth", unitId: "unit-c", fw: "test", mac: macFor(randomBytes(32).toString("hex"), ch.nonce as string) });
    await d.next(t("register"));
    d.send({ t: "register", unitId: "unit-c", secret: randomBytes(32).toString("hex") });
    expect(await d.closed).toBe(4001);
    expect(await store.getUnit("unit-c")).toBeNull();
  });
});

describe("pairing", () => {
  it("a code is single use", async () => {
    const { code } = await pairedUnit("unit-p");
    const p2 = await phone();
    p2.send({ type: "pair", code, ownerToken: token() });
    expect(await p2.next(t("error"))).toMatchObject({ code: "bad_code" });
  });

  it("a wrong code is rejected", async () => {
    const { d } = await device("unit-w");
    const code = (await d.next(t("pair_code"))).code as string;
    const wrong = code === "AAAAAA" ? "BBBBBB" : "AAAAAA";
    const p = await phone();
    p.send({ type: "pair", code: wrong, ownerToken: token() });
    expect(await p.next(t("error"))).toMatchObject({ code: "bad_code" });
  });

  it("an expired code is rejected and a new one is shown", async () => {
    await hub.close();
    await startHub({ pairingCodeTtlSeconds: 0.3 });
    const { d } = await device("unit-x");
    const first = (await d.next(t("pair_code"))).code as string;
    const second = await d.next(t("pair_code"), 2000);
    expect(second.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const p = await phone();
    if (second.code !== first) {
      p.send({ type: "pair", code: first, ownerToken: token() });
      expect(await p.next(t("error"))).toMatchObject({ code: "bad_code" });
    }
  });

  it("auth with an unknown owner token is unauthorized", async () => {
    const p = await phone();
    p.send({ type: "auth", ownerToken: token() });
    expect(await p.next(t("error"))).toMatchObject({ code: "unauthorized" });
    p.send({ type: "scan", on: true });
    expect(await p.next(t("error"))).toMatchObject({ code: "not_authenticated" });
  });

  it("reconnecting phone and device keep the pairing", async () => {
    const { d, p, ownerToken, secret } = await pairedUnit("unit-r");
    p.send({ type: "oled", lines: ["READY"] });
    expect(await d.next(t("oled"))).toMatchObject({ lines: ["READY"] });
    p.close();
    d.close();
    await d.closed;
    const p2 = await phone();
    p2.send({ type: "auth", ownerToken });
    expect(await p2.next(t("hello"))).toEqual({ type: "hello", protocol: 3, online: false });
    const { d: d2 } = await device("unit-r", secret);
    expect(await d2.next(t("oled"))).toMatchObject({ lines: ["READY"] }); // last OLED replayed
    expect(await p2.next(t("device_status"))).toEqual({ type: "device_status", online: true });
  });

  it("unpair clears the owner and shows a new code", async () => {
    const { d, p, ownerToken } = await pairedUnit("unit-u");
    p.send({ type: "unpair" });
    const pc = await d.next(t("pair_code"));
    expect(pc.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    await p.closed;
    expect((await store.getUnit("unit-u"))?.ownerTokenHash).toBeNull();
    const p2 = await phone();
    p2.send({ type: "auth", ownerToken });
    expect(await p2.next(t("error"))).toMatchObject({ code: "unauthorized" });
  });
});

describe("pairing lasts one power-on (boot id)", () => {
  it("a reconnect within the same boot keeps the pairing", async () => {
    const boot = bootId();
    const { d, p, secret } = await pairedUnit("unit-same", { boot });
    p.send({ type: "oled", lines: ["READY"] });
    await d.next(t("oled"));
    d.close();
    expect(await p.next(t("device_status"))).toEqual({ type: "device_status", online: false });
    const { d: d2, authOk } = await device("unit-same", secret, { boot });
    expect(authOk).toEqual({ t: "auth_ok", paired: true });
    expect(await d2.next(t("oled"))).toMatchObject({ lines: ["READY"] });
    expect(await d2.none(t("pair_code"))).toBe(true);
    expect(await p.next(t("device_status"))).toEqual({ type: "device_status", online: true });
  });

  it("a new boot unpairs: phones are closed, the owner is cleared, a fresh code is shown", async () => {
    const { d, p, secret, ownerToken, code } = await pairedUnit("unit-reboot", { boot: bootId() });
    p.send({ type: "scan", on: true });
    await p.next(t("scan_state"));
    d.ws.terminate(); // power cut
    const { d: d2, authOk } = await device("unit-reboot", secret, { boot: bootId() });
    expect(authOk).toEqual({ t: "auth_ok", paired: false });
    const pc = await d2.next(t("pair_code"));
    expect(pc.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(pc.code).not.toBe(code);
    expect(await p.closed).toBe(PHONE_CLOSE_UNPAIRED);
    expect(p.closeReason).toBe("glasses_restarted");
    expect((await store.getUnit("unit-reboot"))?.ownerTokenHash).toBeNull();
    const p2 = await phone();
    p2.send({ type: "auth", ownerToken });
    expect(await p2.next(t("error"))).toMatchObject({ code: "unauthorized" });
    // and the fresh code pairs normally
    const p3 = await phone();
    p3.send({ type: "pair", code: pc.code, ownerToken: token() });
    expect(await p3.next(t("hello"))).toMatchObject({ online: true });
  });

  it("a new boot replaces a still-registered dead device socket and unpairs", async () => {
    const { p, secret } = await pairedUnit("unit-ghost", { boot: bootId() });
    // the old socket is never closed (power cut not yet noticed)
    const { authOk } = await device("unit-ghost", secret, { boot: bootId() });
    expect(authOk).toEqual({ t: "auth_ok", paired: false });
    expect(await p.closed).toBe(PHONE_CLOSE_UNPAIRED);
  });

  it("after a hub restart the first boot id is unknown: the stored pairing is kept", async () => {
    const { d, secret, ownerToken } = await pairedUnit("unit-hubrestart", { boot: bootId() });
    d.close();
    await d.closed;
    await hub.close();
    await startHub({ keepStore: true });
    const { authOk } = await device("unit-hubrestart", secret, { boot: bootId() });
    expect(authOk).toEqual({ t: "auth_ok", paired: true });
    const p = await phone();
    p.send({ type: "auth", ownerToken });
    expect(await p.next(t("hello"))).toEqual({ type: "hello", protocol: 3, online: true });
  });

  it("older firmware without a boot id keeps the pairing", async () => {
    const { d, p, secret } = await pairedUnit("unit-old", { boot: bootId() });
    d.close();
    await d.closed;
    const { authOk } = await device("unit-old", secret);
    expect(authOk).toEqual({ t: "auth_ok", paired: true });
    expect(await p.next(t("device_status"))).toEqual({ type: "device_status", online: false });
    expect(await p.next(t("device_status"))).toEqual({ type: "device_status", online: true });
  });

  it("phone Unpair still closes other phones with reason unpaired", async () => {
    const { p, ownerToken } = await pairedUnit("unit-two", { boot: bootId() });
    const p2 = await phone();
    p2.send({ type: "auth", ownerToken });
    await p2.next(t("hello"));
    p.send({ type: "unpair" });
    expect(await p2.closed).toBe(PHONE_CLOSE_UNPAIRED);
    expect(p2.closeReason).toBe("unpaired");
    expect(await p.closed).toBe(1000);
  });
});

describe("heartbeat", () => {
  // Only the ping interval is faked; sockets and the hub's other timers stay real.
  const tick = async () => {
    vi.advanceTimersByTime(HEARTBEAT.pingEveryMs);
    await new Promise((r) => setTimeout(r, 60)); // let pongs and closes travel
  };

  beforeEach(async () => {
    await hub.close();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await startHub();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a silent device (power cut) goes offline after ~10 s: scan stops, phones told", async () => {
    const { d, p } = await pairedUnit("unit-hb", { autoPong: false });
    p.send({ type: "scan", on: true });
    await p.next(t("scan_state"));
    await tick(); // ping 1
    await tick(); // ping 2
    expect(d.ws.readyState).toBe(WebSocket.OPEN);
    expect(await p.none(t("device_status"), 50)).toBe(true);
    await tick(); // 2 unanswered pings: terminated
    expect(await p.next(t("scan_state"))).toEqual({ type: "scan_state", on: false, reason: "device_offline" });
    expect(await p.next(t("device_status"))).toEqual({ type: "device_status", online: false });
    expect(await d.closed).toBe(1006);
    expect(p.ws.readyState).toBe(WebSocket.OPEN); // the phone answers its pings
    p.send({ type: "scan", on: true });
    expect(await p.next(t("error"))).toMatchObject({ code: "device_offline" });
  });

  it("a device that answers pings stays online", async () => {
    const { d, p } = await pairedUnit("unit-alive");
    for (let i = 0; i < 6; i++) await tick();
    expect(d.ws.readyState).toBe(WebSocket.OPEN);
    expect(await p.none(t("device_status"), 50)).toBe(true);
  });

  it("a dead phone is terminated and the camera stops", async () => {
    const { d } = await device("unit-hbp");
    const code = (await d.next(t("pair_code"))).code as string;
    const p = await phone(ORIGIN, false);
    p.send({ type: "pair", code, ownerToken: token() });
    await p.next(t("hello"));
    p.send({ type: "scan", on: true });
    expect(await d.next(t("stream"))).toMatchObject({ on: true });
    await tick();
    await tick();
    await tick();
    expect(await p.closed).toBe(1006);
    expect(await d.next(t("stream"))).toMatchObject({ on: false });
    expect(d.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("phone connection", () => {
  it("rejects a foreign Origin", async () => {
    await expect(phone("https://evil.example")).rejects.toThrow(/403/);
    const noOrigin = client("/phone");
    await expect(noOrigin.open()).rejects.toThrow(/403/);
  });

  it("answers bad_message for invalid or oversized messages", async () => {
    const p = await phone();
    p.send({ type: "nope" });
    expect(await p.next(t("error"))).toMatchObject({ code: "bad_message" });
    p.ws.send("{not json");
    expect(await p.next(t("error"))).toMatchObject({ code: "bad_message" });
    p.ws.send("x".repeat(LIMITS.jsonMaxBytes + 1));
    expect(await p.next(t("error"))).toMatchObject({ code: "bad_message" });
  });

  it("issues a verifiable ticket after hello and on request", async () => {
    const { p } = await pairedUnit("unit-t");
    const first = await p.next(t("ticket"));
    expect(HubToPhone.safeParse(first).success).toBe(true);
    expect(verifyTicket(first.token, SECRET)).not.toBeNull();
    p.send({ type: "ticket_request" });
    const second = await p.next(t("ticket"));
    expect(verifyTicket(second.token, SECRET)?.exp).toBe(second.exp);
    expect(second.token).not.toBe(first.token);
  });
});

describe("frames", () => {
  it("reach only the paired phone of the same unit", async () => {
    const a = await pairedUnit("unit-1");
    const b = await pairedUnit("unit-2");
    a.p.send({ type: "scan", on: true });
    expect(await a.d.next(t("stream"))).toEqual({ t: "stream", on: true, fps: 5, size: "QVGA" });
    expect(await a.p.next(t("scan_state"))).toEqual({ type: "scan_state", on: true, reason: "phone" });
    a.d.ws.send(jpegOf("a"), { binary: true });
    const f = await a.p.next(t("frame"));
    expect(HubToPhone.safeParse(f).success).toBe(true);
    expect(Buffer.from(f.dataBase64 as string, "base64").equals(jpegOf("a"))).toBe(true);
    expect(await b.p.none(t("frame"))).toBe(true);
    expect(await b.d.none(t("stream"), 50)).toBe(true);
  });

  it("are not forwarded while scan is off, and non-JPEG frames are dropped", async () => {
    const { d, p } = await pairedUnit("unit-off");
    d.ws.send(JPEG, { binary: true });
    expect(await p.none(t("frame"))).toBe(true);
    p.send({ type: "scan", on: true });
    await d.next(t("stream"));
    await p.next(t("scan_state"));
    d.ws.send(Buffer.from("not a jpeg"), { binary: true });
    expect(await p.none(t("frame"))).toBe(true);
    p.send({ type: "scan", on: false });
    expect(await d.next(t("stream"))).toMatchObject({ on: false });
    expect(await p.next(t("scan_state"))).toMatchObject({ on: false, reason: "phone" });
    d.ws.send(JPEG, { binary: true });
    expect(await p.none(t("frame"))).toBe(true);
  });

  it("stop after the stream cap without a fresh scan{on}", async () => {
    await hub.close();
    await startHub({ streamMaxMs: 300 });
    const { d, p } = await pairedUnit("unit-cap");
    p.send({ type: "scan", on: true });
    await d.next(t("stream"));
    await p.next(t("scan_state"));
    // A refresh before the cap extends it.
    await new Promise((r) => setTimeout(r, 200));
    p.send({ type: "scan", on: true });
    // The refresh is re-sent to the device (firmware has its own 20 s camera timeout).
    expect(await d.next(t("stream"))).toMatchObject({ on: true });
    await new Promise((r) => setTimeout(r, 200));
    d.ws.send(JPEG, { binary: true });
    await p.next(t("frame"));
    expect(await p.next(t("scan_state"), 1000)).toEqual({ type: "scan_state", on: false, reason: "timeout" });
    expect(await d.next(t("stream"))).toMatchObject({ on: false });
    d.ws.send(JPEG, { binary: true });
    expect(await p.none(t("frame"))).toBe(true);
  });

  it("device drop ends the scan and reports offline", async () => {
    const { d, p } = await pairedUnit("unit-drop");
    p.send({ type: "scan", on: true });
    await p.next(t("scan_state"));
    d.close();
    expect(await p.next(t("scan_state"))).toEqual({ type: "scan_state", on: false, reason: "device_offline" });
    expect(await p.next(t("device_status"))).toEqual({ type: "device_status", online: false });
    p.send({ type: "scan", on: true });
    expect(await p.next(t("error"))).toMatchObject({ code: "device_offline" });
  });
});

describe("logs", () => {
  it("never contain tokens, codes, secrets, unit ids, OLED text or image data", async () => {
    const captured: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...a: unknown[]) => void captured.push(a.join(" "));
    try {
      await hub.close();
      store = new MemoryUnitStore();
      hub = createHub({ store, ticketSecret: SECRET, ticketTtlSeconds: 600, allowedOrigins: [ORIGIN] }); // default console logger
      base = `ws://127.0.0.1:${await hub.listen(0, "127.0.0.1")}`;
      const boot = bootId();
      const { d, p, ownerToken, secret, code } = await pairedUnit("unit-secret-name", { boot });
      const ticket = (await p.next(t("ticket"))).token as string;
      p.send({ type: "oled", lines: ["PAY 2 USDC", "SAY CONFIRM 47"] });
      await d.next(t("oled"));
      p.send({ type: "scan", on: true });
      await d.next(t("stream"));
      d.ws.send(JPEG, { binary: true });
      const f = await p.next(t("frame"));
      p.send({ type: "scan", on: false });
      await p.next(t("scan_state"));
      p.send({ type: "auth", ownerToken: "nothex" });
      await p.next(t("error"));
      const all = captured.join("\n");
      expect(captured.length).toBeGreaterThan(3);
      for (const s of [ownerToken, secret, code, ticket, f.dataBase64 as string, JPEG.toString("base64").slice(0, 20), "unit-secret-name", "USDC", "CONFIRM", "127.0.0.1", boot]) {
        expect(all).not.toContain(s);
      }
    } finally {
      Object.assign(console, orig);
    }
  });
});

function jpegOf(tag: string) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(tag.repeat(50)), Buffer.from([0xff, 0xd9])]);
}
