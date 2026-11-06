// PayController with every I/O module faked: the "want to pay?" ask, its cancellation paths, synced OLED + voice,
// and the error paths. Test fixtures only (invariant 9): nothing here ships.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oledStates } from "@cpay/glasses-kit/hub";
import type { HubStatus } from "../lib/hub-client.js";

type Rec = { blob: Blob; ms: number; verdict: "fixed" | "stop_silence"; heardSpeech: boolean };
const io = vi.hoisted(() => ({
  spoken: [] as string[],
  /** Next record() outcome: a recording, an error, or "hang" (until aborted). */
  nextRec: [] as (Rec | Error | "hang")[],
  recordCalls: [] as unknown[],
  transcript: "yes",
  transcribeCalls: 0,
}));

vi.mock("../lib/voice-io.js", () => ({
  beep: vi.fn(),
  unlockAudio: vi.fn(),
  record: vi.fn(async (opts: unknown, signal?: AbortSignal) => {
    io.recordCalls.push(opts);
    const n = io.nextRec.shift() ?? { blob: new Blob(["x"]), ms: 5000, verdict: "fixed", heardSpeech: true };
    if (n instanceof Error) throw n;
    if (n === "hang")
      return new Promise((resolve) =>
        signal?.addEventListener("abort", () => resolve({ blob: new Blob([]), ms: 1, verdict: "fixed", heardSpeech: false })),
      );
    return n;
  }),
}));
vi.mock("../lib/voice-feedback.js", () => ({
  sayWithToast: vi.fn(async (t: string) => {
    io.spoken.push(t);
    return { played: true, evidence: [] };
  }),
}));
vi.mock("../lib/zg-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/zg-client.js")>()),
  transcribe: vi.fn(async () => {
    io.transcribeCalls++;
    return { text: io.transcript, evidence: [{ kind: "stt", requestId: "r1", receipt: "verified" }] };
  }),
  intentFromAudio: vi.fn(),
}));
vi.mock("../lib/frame-qr.js", () => ({ decodeQrFromJpeg: vi.fn(), frameBlob: vi.fn() }));
vi.mock("../lib/agent-pass-client.js", () => ({ linkedSubHash: vi.fn(), openApprovalWindow: vi.fn(), runAgentPass: vi.fn() }));
vi.mock("../lib/railgun.js", () => ({ canPayPrivately: vi.fn(), getRailgun: vi.fn(), refreshPrivate: vi.fn() }));
vi.mock("../lib/wallet.js", () => ({
  approvalBinding: vi.fn(),
  approvalCommit: vi.fn(),
  evaluatePolicy: vi.fn(),
  matchConfirm: vi.fn(),
  newConfirmCode: vi.fn(() => 47),
  parseQr: vi.fn(),
  payDirect: vi.fn(),
  recordSpend: vi.fn(),
  toBaseUnits: vi.fn(),
  txUrl: vi.fn((h: string) => `https://x/tx/${h}`),
  unsupportedWhy: vi.fn(),
  verifyApproval: vi.fn(),
}));
vi.mock("../app/pay/private-flow.js", () => ({
  PrivateFlow: class {
    resetScan() {}
    onFrame() {}
  },
}));

const { PayController } = await import("../app/pay/controller.js");
const { toast } = await import("../lib/toast.js");

class FakeHub {
  status: HubStatus = { conn: "connected", online: true, scanning: false, lastError: null, ended: null };
  oled: string[][] = [];
  scans: boolean[] = [];
  scanOk = true;
  private l = new Set<(s: HubStatus) => void>();
  onStatus(fn: (s: HubStatus) => void) {
    this.l.add(fn);
    fn(this.status);
    return () => this.l.delete(fn);
  }
  set(p: Partial<HubStatus>) {
    this.status = { ...this.status, ...p };
    this.l.forEach((f) => f(this.status));
  }
  setOled(lines: string[]) {
    this.oled.push(lines);
    return true;
  }
  scan(on: boolean) {
    this.scans.push(on);
    return this.scanOk;
  }
  getTicket = async () => "ticket";
  onFrame = () => () => undefined;
  onScanState = () => () => undefined;
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
};
const wallet = {} as never;

let hub: FakeHub;
let ctrl: InstanceType<typeof PayController>;
let detach: () => void;

/** Each test starts with the glasses offline, so attaching + going online is a fresh offline -> online edge. */
async function setup(opts: { unlocked?: boolean } = {}) {
  hub = new FakeHub();
  hub.status = { ...hub.status, online: false };
  ctrl = new PayController(hub as never, () => (opts.unlocked === false ? null : wallet));
  detach = ctrl.attach();
  hub.set({ online: true });
  await flush();
}

beforeEach(() => {
  io.spoken = [];
  io.nextRec = [];
  io.recordCalls = [];
  io.transcript = "yes";
  io.transcribeCalls = 0;
  toast.clear();
});
afterEach(() => {
  hub?.set({ online: false }); // reset the tab-wide ask memory for the next test
  detach?.();
});

describe("want to pay? (hands-free start)", () => {
  it("asks once when the glasses come online; 'yes' starts a scan with OLED + voice in sync", async () => {
    await setup();
    expect(hub.oled[0]).toEqual(oledStates.wantToPay());
    expect(io.spoken[0]).toBe("wantToPay");
    expect(io.recordCalls[0]).toEqual({ mode: "fixed", ms: 5000 });
    expect(io.transcribeCalls).toBe(1);
    const v = ctrl.getView();
    expect(v.state.s).toBe("SCANNING");
    expect(v.ask).toBe("idle");
    expect(hub.scans).toEqual([true]);
    expect(hub.oled.at(-1)).toEqual(oledStates.scanning());
    expect(io.spoken).toContain("scanning");
    expect(v.evidence).toHaveLength(1); // the ask's STT evidence is kept
    // Not asked again on later status updates.
    hub.set({ scanning: true });
    await flush();
    expect(io.spoken.filter((t) => t === "wantToPay")).toHaveLength(1);
  });

  it("'not now' (or anything unclear) says notNow, OLED ready, no scan", async () => {
    io.transcript = "not now";
    await setup();
    expect(ctrl.getView().state.s).toBe("IDLE");
    expect(hub.scans).toEqual([]);
    expect(io.spoken).toEqual(["wantToPay", "notNow"]);
    expect(hub.oled.at(-1)).toEqual(oledStates.ready());
  });

  it("silence is never sent to 0G and is a not-now", async () => {
    io.nextRec = [{ blob: new Blob([]), ms: 5000, verdict: "fixed", heardSpeech: false }];
    await setup();
    expect(io.transcribeCalls).toBe(0);
    expect(io.spoken).toEqual(["wantToPay", "notNow"]);
    expect(ctrl.getView().state.s).toBe("IDLE");
  });

  it("tapping Scan while the mic is open cancels the ask and scans", async () => {
    io.nextRec = ["hang"];
    await setup();
    expect(ctrl.getView().ask).toBe("listening");
    expect(ctrl.getView().micOn).toBe(true);
    ctrl.startScan();
    await flush();
    expect(ctrl.getView().state.s).toBe("SCANNING");
    expect(ctrl.getView().ask).toBe("idle");
    expect(ctrl.getView().micOn).toBe(false);
    expect(io.transcribeCalls).toBe(0);
    expect(io.spoken).not.toContain("notNow");
  });

  it("Stop cancels the ask: mic off, OLED ready, nothing spoken after", async () => {
    io.nextRec = ["hang"];
    await setup();
    ctrl.stop();
    await flush();
    expect(ctrl.getView().ask).toBe("idle");
    expect(ctrl.getView().micOn).toBe(false);
    expect(hub.oled.at(-1)).toEqual(oledStates.ready());
    expect(io.spoken).toEqual(["wantToPay"]);
  });

  it("glasses dropping mid-ask stops the mic; coming back asks again", async () => {
    io.nextRec = ["hang"];
    await setup();
    hub.set({ online: false });
    await flush();
    expect(ctrl.getView().ask).toBe("idle");
    expect(ctrl.getView().micOn).toBe(false);
    io.transcript = "no";
    hub.set({ online: true });
    await flush();
    expect(io.spoken.filter((t) => t === "wantToPay")).toHaveLength(2);
  });

  it("mic blocked: the ask ends visibly (toast + OLED ready)", async () => {
    io.nextRec = [new DOMException("denied", "NotAllowedError") as unknown as Error];
    await setup();
    expect(ctrl.getView().ask).toBe("idle");
    expect(hub.oled.at(-1)).toEqual(oledStates.ready());
    expect(toast.getSnapshot().map((t) => t.text)).toContain("Microphone blocked: allow it for this site. Press Scan to pay.");
  });

  it("never asks with the wallet locked; unlocking asks", async () => {
    let unlocked = false;
    hub = new FakeHub();
    hub.status = { ...hub.status, online: false };
    ctrl = new PayController(hub as never, () => (unlocked ? wallet : null));
    detach = ctrl.attach();
    io.transcript = "no";
    hub.set({ online: true });
    await flush();
    expect(io.spoken).toEqual([]);
    unlocked = true;
    ctrl.walletChanged(true);
    await flush();
    expect(io.spoken).toEqual(["wantToPay", "notNow"]);
  });

  it("asks again after a payment fails, but not after a Stop tap", async () => {
    io.transcript = "no";
    await setup();
    // A failed session (glasses refuse the camera): payFailed voice, then the ask is owed once more.
    hub.scanOk = false;
    ctrl.startScan();
    await flush(10);
    expect(ctrl.getView().state.s).toBe("FAILED");
    expect(io.spoken).toEqual(["wantToPay", "notNow", "payFailed", "wantToPay", "notNow"]);
    // A Stop tap during a scan: "cancelled" and no ask after it.
    hub.scanOk = true;
    ctrl.startScan();
    ctrl.stop();
    await flush(10);
    expect(ctrl.getView().state.s).toBe("CANCELLED");
    expect(io.spoken.slice(5)).toEqual(["cancelled"]);
  });
});

describe("glasses drop mid-session", () => {
  it("stops the scan and says so (voice + status), nothing paid", async () => {
    io.transcript = "yes";
    await setup();
    expect(ctrl.getView().state.s).toBe("SCANNING");
    hub.set({ online: false });
    await flush();
    const st = ctrl.getView().state;
    expect(st).toEqual({ s: "CANCELLED", reason: "Glasses disconnected" });
    expect(hub.scans.at(-1)).toBe(false);
    expect(io.spoken.at(-1)).toBe("cancelled");
    await flush();
    expect(toast.getSnapshot().map((t) => t.text)).toContain("Glasses disconnected — nothing was paid");
  });
});
