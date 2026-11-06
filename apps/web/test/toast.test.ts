import { describe, expect, it, vi } from "vitest";
import { TOAST_LIMITS, ToastStore } from "../lib/toast.js";

describe("ToastStore", () => {
  it("keeps at most two toasts, newest last", () => {
    const s = new ToastStore();
    s.info("a");
    s.info("b");
    s.error("c");
    expect(s.getSnapshot().map((t) => t.text)).toEqual(["b", "c"]);
  });

  it("expires info toasts but keeps errors until dismissed", () => {
    vi.useFakeTimers();
    try {
      const s = new ToastStore();
      s.info("hi");
      const id = s.error("boom");
      vi.advanceTimersByTime(TOAST_LIMITS.infoMs + 1);
      expect(s.getSnapshot().map((t) => t.text)).toEqual(["boom"]);
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
