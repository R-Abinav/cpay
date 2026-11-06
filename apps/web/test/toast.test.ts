import { describe, expect, it, vi } from "vitest";
import { TOAST_LIMITS, ToastStore } from "../lib/toast.js";

describe("ToastStore", () => {
  it("default timers work like a browser's (setTimeout as a method throws Illegal invocation)", () => {
    const real = globalThis.setTimeout;
    const browserLike = function (this: unknown, fn: () => void, ms?: number) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return real(fn, ms);
    };
    vi.stubGlobal("setTimeout", browserLike);
    try {
      const s = new ToastStore();
      expect(() => s.info("hello")).not.toThrow();
      expect(s.getSnapshot().map((t) => t.text)).toEqual(["hello"]);
      s.clear();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("keeps at most two toasts, newest last", () => {
    const s = new ToastStore();
    s.info("a");
    s.info("b");
    s.error("c");
    expect(s.getSnapshot().map((t) => t.text)).toEqual(["b", "c"]);
  });

  it("expires info after 3 s and errors after 4 s; a tap dismisses sooner", () => {
    vi.useFakeTimers();
    try {
      const s = new ToastStore();
      s.info("hi");
      s.error("boom");
      vi.advanceTimersByTime(TOAST_LIMITS.infoMs + 1);
      expect(s.getSnapshot().map((t) => t.text)).toEqual(["boom"]);
      vi.advanceTimersByTime(TOAST_LIMITS.alertMs - TOAST_LIMITS.infoMs);
      expect(s.getSnapshot()).toEqual([]);
      const id = s.warn("tap me");
      s.dismiss(id);
      expect(s.getSnapshot()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes a repeated text instead of stacking it", () => {
    const s = new ToastStore();
    s.info("same");
    s.info("same");
    expect(s.getSnapshot()).toHaveLength(1);
  });

  it("notifies subscribers", () => {
    const s = new ToastStore();
    const fn = vi.fn();
    s.subscribe(fn);
    s.warn("x");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("toastSafe", () => {
  it("cuts viem detail sections, shortens addresses and caps length", async () => {
    const { toastSafe, errText, TOAST_MAX_CHARS } = await import("../lib/toast.js");
    const a = "0x" + "ab".repeat(20);
    const out = toastSafe(`Payment failed: insufficient funds for ${a}\n\nRequest Arguments:\n  from: ${a}\n  data: 0x${"00".repeat(68)}`);
    expect(out).toBe("Payment failed: insufficient funds for 0xabab…abab");
    expect(toastSafe("x".repeat(500)).length).toBe(TOAST_MAX_CHARS);
    const e = Object.assign(new Error(`long ${a}`), { shortMessage: "Execution reverted." });
    expect(errText(e)).toBe("Execution reverted.");
    const s = new (await import("../lib/toast.js")).ToastStore();
    s.error(`Move failed from ${a}`);
    expect(s.getSnapshot()[0]!.text).toBe("Move failed from 0xabab…abab");
  });
});
