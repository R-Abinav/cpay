import { describe, expect, it } from "vitest";
import {
  BridgeToWeb,
  C3ToBridge,
  CamToBridge,
  WebToBridge,
  decodeCamFrame,
  oledStates,
  parseJson,
} from "../src/messages.js";

describe("WebToBridge", () => {
  it("accepts an OLED message", () => {
    expect(WebToBridge.parse({ type: "oled", lines: ["READY"] })).toEqual({ type: "oled", lines: ["READY"] });
  });
  it("accepts a capture request", () => {
    expect(WebToBridge.safeParse({ type: "capture_request" }).success).toBe(true);
  });
  it("rejects empty, too many, too long and non-ASCII lines", () => {
    expect(WebToBridge.safeParse({ type: "oled", lines: [] }).success).toBe(false);
    expect(WebToBridge.safeParse({ type: "oled", lines: Array(7).fill("x") }).success).toBe(false);
    expect(WebToBridge.safeParse({ type: "oled", lines: ["x".repeat(22)] }).success).toBe(false);
    expect(WebToBridge.safeParse({ type: "oled", lines: ["héllo"] }).success).toBe(false);
    expect(WebToBridge.safeParse({ type: "oled", lines: ["a\nb"] }).success).toBe(false);
  });
  it("rejects unknown types", () => {
    expect(WebToBridge.safeParse({ type: "pay", amount: 2 }).success).toBe(false);
  });
});

describe("oledStates", () => {
  it("builds every HARDWARE.md state as a valid message", () => {
    const all = [
      oledStates.ready(),
      oledStates.listening(),
      oledStates.verified("2", "USDC"),
      oledStates.noVerifiedRecipient(),
      oledStates.paid(),
      oledStates.cancelled(),
      oledStates.approveOnPhone(),
      oledStates.brainOffline(),
    ];
    for (const m of all) expect(WebToBridge.safeParse(m).success).toBe(true);
    expect(oledStates.verified("2", "USDC").lines).toEqual(["VERIFIED HUMAN", "2 USDC", "OK?"]);
  });
  it("refuses junk amounts or tokens", () => {
    expect(() => oledStates.verified("2; DROP", "USDC")).toThrow();
    expect(() => oledStates.verified("2", "usdc!")).toThrow();
  });
});

describe("device messages", () => {
  it("parses C3 button events", () => {
    expect(parseJson(C3ToBridge, '{"t":"btn","e":"confirm"}')).toEqual({ t: "btn", e: "confirm" });
    expect(parseJson(C3ToBridge, '{"t":"btn","e":"self_destruct"}')).toBeNull();
    expect(parseJson(C3ToBridge, "not json")).toBeNull();
  });
  it("parses CAM hello and errors", () => {
    expect(parseJson(CamToBridge, '{"t":"hello","role":"cam","fw":"0.1.0","map":"AI_THINKER"}')).not.toBeNull();
    expect(parseJson(CamToBridge, '{"t":"capture_error","id":3,"reason":"fb_get_failed"}')).toEqual({
      t: "capture_error",
      id: 3,
      reason: "fb_get_failed",
    });
  });
  it("decodes a binary CAM frame", () => {
    const buf = Uint8Array.from([0, 0, 1, 2, 0xff, 0xd8, 0xff, 0xd9]);
    const f = decodeCamFrame(buf);
    expect(f?.id).toBe(258);
    expect(Array.from(f!.jpeg)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });
  it("rejects non-JPEG or short binary frames", () => {
    expect(decodeCamFrame(Uint8Array.from([0, 0, 0, 1, 0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(decodeCamFrame(Uint8Array.from([0, 0, 0, 1]))).toBeNull();
  });
});

describe("BridgeToWeb", () => {
  it("validates the messages the web app receives", () => {
    expect(BridgeToWeb.safeParse({ type: "button", event: "capture_down", ts: 1 }).success).toBe(true);
    expect(
      BridgeToWeb.safeParse({ type: "frame", id: 1, mime: "image/jpeg", bytes: 4, dataBase64: "/9j/", ts: 1 }).success,
    ).toBe(true);
    expect(BridgeToWeb.safeParse({ type: "frame_error", id: null, reason: "cam_offline" }).success).toBe(true);
    expect(BridgeToWeb.safeParse({ type: "frame", id: 1, mime: "image/png", bytes: 4, dataBase64: "x", ts: 1 }).success).toBe(
      false,
    );
  });
});
