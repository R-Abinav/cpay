import { describe, expect, it } from "vitest";
import { askReducer, initialAsk, matchWantToPay, shouldAsk, type AskContext, type AskEvent, type AskState } from "../lib/ask-pay.js";

describe("matchWantToPay (deterministic, phone-side)", () => {
  it("yes words start a scan", () => {
    for (const t of ["yes", "Yes.", "yeah", "Yep!", "sure", "ok", "OK", "O.K.", "okay", "pay", "scan", "yes please", "Okay, scan it", "Sure, let's pay"]) {
      expect(matchWantToPay(t), t).toBe("yes");
    }
  });
  it("refusals win, even next to a yes word", () => {
    for (const t of ["no", "No.", "not now", "cancel", "stop", "nope", "no, don't pay", "Don't scan", "yes... no wait", "later"]) {
      expect(matchWantToPay(t), t).toBe("no");
    }
  });
  it("silence and anything else is not a yes", () => {
    expect(matchWantToPay("")).toBe("silence");
    expect(matchWantToPay("  ... ")).toBe("silence");
    for (const t of ["hello", "what time is it", "yesterday", "payment", "okayish", "scanner"]) expect(matchWantToPay(t), t).toBe("unclear");
  });
});

const run = (evs: AskEvent[], st: AskState = initialAsk) => evs.reduce(askReducer, st);
const ctx: AskContext = { enabled: true, walletUnlocked: true, payTabOpen: true, payIdle: true, glassesReady: true };

describe("ask state", () => {
  it("glasses coming online arm exactly one ask", () => {
    const armed = run([{ t: "GLASSES", online: true }]);
    expect(armed).toEqual({ online: true, armed: true, phase: "idle" });
    expect(shouldAsk(armed, ctx)).toBe(true);
    // Repeated "online" status updates don't re-arm.
    const asked = run([{ t: "START" }, { t: "LISTEN" }, { t: "RECORDED" }, { t: "ANSWER" }, { t: "GLASSES", online: true }], armed);
    expect(asked).toEqual({ online: true, armed: false, phase: "idle" });
    expect(shouldAsk(asked, ctx)).toBe(false);
  });
  it("walks prompting -> listening -> checking -> idle, in order only", () => {
    let st = run([{ t: "GLASSES", online: true }, { t: "START" }]);
    expect(st.phase).toBe("prompting");
    expect(run([{ t: "RECORDED" }], st).phase).toBe("prompting"); // out of order: ignored
    st = run([{ t: "LISTEN" }], st);
    expect(st.phase).toBe("listening");
    st = run([{ t: "RECORDED" }], st);
    expect(st.phase).toBe("checking");
    st = run([{ t: "ANSWER" }], st);
    expect(st).toEqual({ online: true, armed: false, phase: "idle" });
  });
  it("START does nothing unless armed (never on its own / a timer)", () => {
    expect(run([{ t: "START" }])).toEqual(initialAsk);
    const once = run([{ t: "GLASSES", online: true }, { t: "START" }, { t: "LISTEN" }, { t: "RECORDED" }, { t: "ANSWER" }, { t: "START" }]);
    expect(once.phase).toBe("idle");
  });
  it("a payment ending re-arms once", () => {
    const done = run([{ t: "GLASSES", online: true }, { t: "START" }, { t: "LISTEN" }, { t: "RECORDED" }, { t: "ANSWER" }]);
    const again = run([{ t: "PAYMENT_ENDED" }], done);
    expect(again.armed).toBe(true);
    expect(shouldAsk(again, ctx)).toBe(true);
  });
  it("Scan / Stop (CANCEL) ends a running ask and the owed one", () => {
    for (const p of [["START"], ["START", "LISTEN"], ["START", "LISTEN", "RECORDED"]] as const) {
      const st = run([{ t: "GLASSES", online: true }, ...p.map((t) => ({ t }) as AskEvent), { t: "CANCEL" }]);
      expect(st).toEqual({ online: true, armed: false, phase: "idle" });
    }
    expect(run([{ t: "GLASSES", online: true }, { t: "CANCEL" }]).armed).toBe(false);
  });
  it("glasses dropping stops the ask; coming back asks again", () => {
    const listening = run([{ t: "GLASSES", online: true }, { t: "START" }, { t: "LISTEN" }]);
    const dropped = run([{ t: "GLASSES", online: false }], listening);
    expect(dropped).toEqual({ online: false, armed: false, phase: "idle" });
    expect(run([{ t: "GLASSES", online: true }], dropped).armed).toBe(true);
  });
  it("asks only when every condition holds", () => {
    const armed = run([{ t: "GLASSES", online: true }]);
    for (const k of Object.keys(ctx) as (keyof AskContext)[]) expect(shouldAsk(armed, { ...ctx, [k]: false }), k).toBe(false);
    expect(shouldAsk({ ...armed, online: false }, ctx)).toBe(false);
    expect(shouldAsk(run([{ t: "START" }], armed), ctx)).toBe(false); // already asking
  });
});
