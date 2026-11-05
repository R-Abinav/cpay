import { describe, expect, it } from "vitest";
import { HubToDevice, HubToPhone, PhoneToHub, oledStates, oled, OLED_MAX_CHARS } from "../src/messages.js";
import { issueTicket, verifyTicket } from "../src/ticket.js";

const SECRET = "x".repeat(64);
const tok = "a".repeat(64);

describe("hub messages", () => {
  it("accepts valid phone messages and rejects bad ones", () => {
    expect(PhoneToHub.safeParse({ type: "pair", code: "AB3K9Q", ownerToken: tok }).success).toBe(true);
    expect(PhoneToHub.safeParse({ type: "pair", code: "AB0K9Q", ownerToken: tok }).success).toBe(false); // 0 not allowed
    expect(PhoneToHub.safeParse({ type: "auth", ownerToken: "nothex" }).success).toBe(false);
    expect(PhoneToHub.safeParse({ type: "scan", on: true }).success).toBe(true);
    expect(PhoneToHub.safeParse({ type: "button" }).success).toBe(false);
  });
  it("parses hub to phone and device messages", () => {
    expect(HubToPhone.safeParse({ type: "hello", protocol: 3, online: true }).success).toBe(true);
    expect(HubToPhone.safeParse({ type: "scan_state", on: false, reason: "timeout" }).success).toBe(true);
    const s = HubToDevice.parse({ t: "stream", on: true });
    expect(s).toMatchObject({ fps: 5, size: "QVGA" });
  });
  it("every OLED screen fits the display", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const o = oledStates;
    const screens = [
      o.ready(), o.scanning(), o.noQr(), o.notWalletQr(), o.wrongNetwork(), o.verifiedHuman(),
      o.publicAddr(addr), o.sayAmountAgain(), o.confirm("2", "USDC", 47), o.confirm("1000000.25", "USDC", 99),
      o.confirmAgain(47), o.noVerifiedRecipient(), o.approveOnPhone(), o.paying(), o.paid("2", "USDC"),
      o.cancelled(), o.brainOffline(),
    ];
    expect(screens.length).toBe(Object.keys(o).length + 1); // confirm is checked twice
    for (const lines of screens) {
      expect(() => oled(lines)).not.toThrow();
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(OLED_MAX_CHARS);
    }
  });
});

describe("hub tickets", () => {
  it("round-trips and expires", () => {
    const now = 1_700_000_000_000;
    const { token } = issueTicket(SECRET, 60, now);
    expect(verifyTicket(token, SECRET, now)?.v).toBe(1);
    expect(verifyTicket(token, SECRET, now + 61_000)).toBeNull();
  });
  it("rejects tampering, wrong secret and junk", () => {
    const { token } = issueTicket(SECRET, 60);
    const [p, s] = token.split(".");
    expect(verifyTicket(`${p}x.${s}`, SECRET)).toBeNull();
    expect(verifyTicket(token, "y".repeat(64))).toBeNull();
    expect(verifyTicket("junk", SECRET)).toBeNull();
    expect(verifyTicket(42, SECRET)).toBeNull();
  });
  it("refuses a short secret", () => {
    expect(() => issueTicket("short", 60)).toThrow();
  });
});
