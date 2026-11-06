// sayWithToast order: local clip (parameter-free templates) -> 0G TTS -> text + "Voice unavailable".
// Fakes stand in for the speaker and network here only (tests); the app wires the real ones.
import { describe, expect, it, vi } from "vitest";
import { hasClip } from "../lib/voice-clips.js";
import { VOICE_UNAVAILABLE, createSay, type SayDeps } from "../lib/voice-feedback.js";

const CLIP = new Uint8Array([1, 2, 3]).buffer;
const TTS = new Uint8Array([9, 9]).buffer;
const EVIDENCE = [{ kind: "tts", requestId: "req-1", receipt: "present" }];

function harness(over: Partial<SayDeps> = {}) {
  let t = 0;
  const calls: string[] = [];
  const deps: SayDeps = {
    loadClip: vi.fn(async (tpl: string) => (hasClip(tpl) ? CLIP : null)),
    speakAudio: vi.fn(async () => ({ audio: TTS, mime: "audio/mpeg", evidence: EVIDENCE })),
    playBytes: vi.fn(async (bytes: ArrayBuffer, onStart: () => void) => {
      calls.push(bytes === CLIP ? "play:clip" : "play:0g");
      t += 5;
      onStart();
    }),
    showToast: vi.fn((_k, text: string) => calls.push(`toast:${text}`)),
    showError: vi.fn((text: string) => calls.push(`error:${text}`)),
    now: () => t,
    ...over,
  };
  return { say: createSay(deps), deps, calls };
}

describe("voice feedback source", () => {
  it("has clips for parameter-free cues and none for amount templates", () => {
    for (const t of ["scanning", "noQr", "noMatch", "wantToPay", "qrFound", "notNow", "cancelled"]) expect(hasClip(t)).toBe(true);
    for (const t of ["ack", "paid", "confirmPrompt", "needApproval", "confirmPromptPublic"]) expect(hasClip(t)).toBe(false);
  });

  it("plays the local clip for a parameter-free template, without 0G or a ticket", async () => {
    const h = harness();
    const r = await h.say("scanning", {}, null);
    expect(r).toMatchObject({ played: true, source: "clip", evidence: [] });
    expect(h.deps.speakAudio).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["play:clip", "toast:Scanning. Look at the QR code or the person you're paying."]);
  });

  it("sends amount templates to 0G TTS and keeps the evidence", async () => {
    const h = harness();
    const r = await h.say("paid", { amount: "2", token: "USDC" }, "ticket");
    expect(r).toMatchObject({ played: true, source: "0g", evidence: EVIDENCE });
    expect(h.deps.speakAudio).toHaveBeenCalledWith("paid", { amount: "2", token: "USDC" }, "ticket");
    expect(h.calls).toEqual(["play:0g", "toast:Paid 2 USDC."]);
  });

  it("falls back to 0G when the clip cannot load", async () => {
    const h = harness({ loadClip: async () => null });
    const r = await h.say("noQr", {}, "ticket");
    expect(r).toMatchObject({ played: true, source: "0g" });
    expect(h.deps.speakAudio).toHaveBeenCalledOnce();
  });

  it("falls back to 0G when the clip fails before any sound", async () => {
    const h = harness();
    const play = h.deps.playBytes as ReturnType<typeof vi.fn>;
    play.mockImplementationOnce(async () => {
      throw new Error("NotAllowedError");
    });
    const r = await h.say("noMatch", {}, "ticket");
    expect(r).toMatchObject({ played: true, source: "0g" });
  });

  it("does not repeat a clip that broke mid-way; flags voice unavailable", async () => {
    const h = harness();
    const play = h.deps.playBytes as ReturnType<typeof vi.fn>;
    play.mockImplementationOnce(async (_b: ArrayBuffer, onStart: () => void) => {
      onStart();
      throw new Error("decode");
    });
    const r = await h.say("scanning", {}, "ticket");
    expect(r.played).toBe(false);
    expect(h.deps.speakAudio).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["toast:Scanning. Look at the QR code or the person you're paying.", `error:${VOICE_UNAVAILABLE}`]);
  });

  it("clip and 0G both failing shows the text and Voice unavailable", async () => {
    const h = harness({ loadClip: async () => null, speakAudio: async () => null });
    const r = await h.say("wantToPay", {}, "ticket");
    expect(r).toMatchObject({ played: false });
    expect(h.calls).toEqual(["toast:Want to pay? Say yes to scan.", `error:${VOICE_UNAVAILABLE}`]);
  });

  it("an amount template with no ticket shows the text and Voice unavailable", async () => {
    const h = harness();
    const r = await h.say("ack", { amount: "2", token: "USDC" }, null);
    expect(r).toMatchObject({ played: false, why: "no hub ticket" });
    expect(h.deps.speakAudio).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["toast:Sure, I'll initiate a 2 USDC payment.", `error:${VOICE_UNAVAILABLE}`]);
  });

  it("the toast appears only when sound starts", async () => {
    const h = harness();
    let toastedBeforeSound = false;
    (h.deps.playBytes as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_b: ArrayBuffer, onStart: () => void) => {
      toastedBeforeSound = (h.deps.showToast as ReturnType<typeof vi.fn>).mock.calls.length > 0;
      onStart();
    });
    await h.say("qrFound", {}, null);
    expect(toastedBeforeSound).toBe(false);
    expect(h.deps.showToast).toHaveBeenCalledOnce();
  });
});
