import { describe, expect, it, vi } from "vitest";
import {
  DIM_AFTER_MS,
  WakeLockKeeper,
  describeEvent,
  dimReducer,
  initialDim,
  msUntilDim,
  pushFeed,
  readyHeadline,
  type HeadlineInput,
  type WakeEnv,
} from "../lib/ready-mode.js";
import type { RecipientEventKind } from "../lib/recipient-service.js";

describe("dim timer", () => {
  it("dims only after DIM_AFTER_MS without activity", () => {
    let s = initialDim(0);
    s = dimReducer(s, { type: "tick", at: DIM_AFTER_MS - 1 });
    expect(s.dimmed).toBe(false);
    s = dimReducer(s, { type: "tick", at: DIM_AFTER_MS });
    expect(s.dimmed).toBe(true);
  });

  it("a touch undims and restarts the timer", () => {
    let s = dimReducer(initialDim(0), { type: "tick", at: 30_000 });
    s = dimReducer(s, { type: "activity", at: 31_000 });
    expect(s).toEqual({ dimmed: false, lastActivity: 31_000 });
    expect(msUntilDim(s, 31_000)).toBe(DIM_AFTER_MS);
    expect(dimReducer(s, { type: "tick", at: 31_000 + DIM_AFTER_MS - 1 }).dimmed).toBe(false);
  });

  it("important events wake the screen; noise doesn't", () => {
    const dimmed = dimReducer(initialDim(0), { type: "tick", at: 25_000 });
    expect(dimReducer(dimmed, { type: "event", at: 26_000, kind: "probe_no_match" })).toBe(dimmed);
    expect(dimReducer(dimmed, { type: "event", at: 26_000, kind: "quote_answered" }).dimmed).toBe(false);
    expect(dimReducer(dimmed, { type: "event", at: 26_000, kind: "matched" }).dimmed).toBe(false);
  });

  it("tick without change returns the same object; msUntilDim is null while dimmed", () => {
    const s = initialDim(0);
    expect(dimReducer(s, { type: "tick", at: 5 })).toBe(s);
    expect(msUntilDim(dimReducer(s, { type: "tick", at: DIM_AFTER_MS }), DIM_AFTER_MS)).toBeNull();
    expect(msUntilDim(s, 5_000)).toBe(DIM_AFTER_MS - 5_000);
  });
});

describe("event feed", () => {
  it("newest first, coalesces repeats within 60 s, bounded", () => {
    let f = pushFeed([], { at: 0, kind: "probe_no_match" });
    f = pushFeed(f, { at: 1_000, kind: "probe_no_match" });
    expect(f).toEqual([{ at: 1_000, kind: "probe_no_match", count: 2 }]);
    f = pushFeed(f, { at: 2_000, kind: "matched" });
    f = pushFeed(f, { at: 70_000, kind: "matched" }); // > 60 s later: new line
    expect(f.map((e) => [e.kind, e.count])).toEqual([
      ["matched", 1],
      ["matched", 1],
      ["probe_no_match", 2],
    ]);
    for (let i = 0; i < 10; i++) f = pushFeed(f, { at: 100_000 * (i + 2), kind: "relay_open" }, 5);
    expect(f).toHaveLength(5);
  });

  it("every kind has fixed text with no digits or hex (no addresses/amounts can leak)", () => {
    const kinds: RecipientEventKind[] = [
      "relay_open",
      "relay_lost",
      "probe_no_match",
      "matched",
      "quote_answered",
      "quote_refused",
      "quote_failed_locked",
      "quote_failed",
    ];
    for (const k of kinds) {
      const d = describeEvent(k);
      expect(d.text.length).toBeGreaterThan(0);
      expect(d.text).not.toMatch(/0x|\d/);
      if (d.link) expect(d.link.href.startsWith("/")).toBe(true);
    }
    expect(describeEvent("probe_no_match").text).toMatch(/not you/);
  });
});

describe("headline", () => {
  const base: HeadlineInput = {
    status: { relay: "open", hasCard: true, invisible: false, reconnectAt: null, detail: "" },
    walletUnlocked: true,
    relayConfigured: true,
    qrReady: true,
    now: 0,
  };
  const h = (p: Partial<HeadlineInput>, st: Partial<HeadlineInput["status"]> = {}) =>
    readyHeadline({ ...base, ...p, status: { ...base.status, ...st } });

  it("ready only when relay open, QR ready, card present, unlocked and visible", () => {
    expect(h({}).tone).toBe("ready");
    expect(h({}).title).toBe("Ready to get paid");
    expect(h({}, { hasCard: false }).tone).toBe("blocked");
    expect(h({}, { invisible: true }).tone).toBe("blocked");
    expect(h({ walletUnlocked: false }).title).toMatch(/Unlock/);
    expect(h({ relayConfigured: false }).tone).toBe("blocked");
    expect(h({ qrReady: false }).tone).toBe("working");
  });

  it("shows reconnect countdown", () => {
    const r = h({ now: 1_000 }, { relay: "closed", reconnectAt: 3_500 });
    expect(r.title).toBe("Reconnecting…");
    expect(r.detail).toMatch(/3 s/);
    expect(h({}, { relay: "closed", detail: "relay connection closed" }).title).toBe("Not connected");
    expect(h({}, { relay: "connecting" }).tone).toBe("working");
  });
});

describe("WakeLockKeeper", () => {
  function env(opts: { supported?: boolean; fail?: boolean } = {}) {
    let visible = true;
    let visFn: (() => void) | null = null;
    const sentinels: { released: boolean; release: () => Promise<void>; fire: () => void }[] = [];
    const request = vi.fn(async () => {
      if (opts.fail) throw new Error("NotAllowedError");
      let onRelease: (() => void) | null = null;
      const s = {
        released: false,
        release: async () => {
          s.released = true;
          onRelease?.();
        },
        addEventListener: (_: "release", fn: () => void) => {
          onRelease = fn;
        },
        fire: () => {
          s.released = true;
          onRelease?.();
        },
      };
      sentinels.push(s);
      return s;
    });
    const e: WakeEnv = {
      wakeLock: opts.supported === false ? undefined : { request },
      isVisible: () => visible,
      onVisibility: (fn) => {
        visFn = fn;
        return () => {
          visFn = null;
        };
      },
    };
    return {
      e,
      request,
      sentinels,
      setVisible(v: boolean) {
        visible = v;
        visFn?.();
      },
      hasListener: () => visFn !== null,
    };
  }

  it("acquires, re-acquires after the system releases on hide, releases on stop", async () => {
    const t = env();
    const k = new WakeLockKeeper(t.e);
    await k.start();
    expect(k.state).toBe("active");
    // Page hidden: the browser releases the lock.
    t.sentinels[0]!.fire();
    t.setVisible(false);
    expect(k.state).toBe("released");
    t.setVisible(true);
    await vi.waitFor(() => expect(k.state).toBe("active"));
    expect(t.request).toHaveBeenCalledTimes(2);
    await k.stop();
    expect(t.sentinels[1]!.released).toBe(true);
    expect(k.state).toBe("idle");
    expect(t.hasListener()).toBe(false);
  });

  it("reports unsupported and denied", async () => {
    const u = new WakeLockKeeper(env({ supported: false }).e);
    await u.start();
    expect(u.state).toBe("unsupported");
    const d = new WakeLockKeeper(env({ fail: true }).e);
    await d.start();
    expect(d.state).toBe("denied");
  });
});
