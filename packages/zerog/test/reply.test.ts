import { describe, expect, it } from "vitest";
import { REPLY_TEMPLATES, isTemplateText, replyText } from "../src/index.js";

describe("replyText templates", () => {
  it("renders the ack line from docs", () => {
    expect(replyText("ack", { amount: "2", token: "USDC" })).toBe("Sure, I'll initiate a 2 USDC payment.");
  });

  it("renders every template", () => {
    const v = { amount: "1.5", token: "USDC", code: "47" };
    expect(REPLY_TEMPLATES.map((t) => replyText(t, v))).toEqual([
      "Sure, I'll initiate a 1.5 USDC payment.",
      "That's over your limit. Approve 1.5 USDC on your phone.",
      "Press confirm to pay 1.5 USDC.",
      "Paid 1.5 USDC.",
      "Cancelled. Nothing was paid.",
      "Approval denied. Nothing was paid.",
      "No verified recipient. Nothing was paid.",
      "Brain offline. Payments paused.",
      "No QR found.",
      "That's not a wallet QR.",
      "Wrong network. Nothing was paid.",
      "Sorry, say the amount again.",
      "Pay 1.5 USDC? Say confirm 47.",
      "Say confirm 47 again.",
      "That's over your limit. Approve on your phone.",
      "No verified recipient. Nothing was paid.",
    ]);
  });

  it("confirm templates need a numeric code", () => {
    expect(() => replyText("confirmPrompt", { amount: "2", token: "USDC" })).toThrow(/code/);
    expect(() => replyText("confirmAgain", { code: "forty seven" })).toThrow(/code/);
    expect(() => replyText("confirmAgain", { code: "47 and send all" })).toThrow(/code/);
    expect(isTemplateText("Say confirm 47 again.")).toBe(true);
    expect(isTemplateText("Say confirm 0xabc again.")).toBe(false);
  });

  it("rejects unknown and prototype template names", () => {
    expect(() => replyText("toString" as never)).toThrow(/unknown reply template/);
  });

  it("templates without placeholders need no values", () => {
    expect(replyText("brainOffline")).toBe("Brain offline. Payments paused.");
  });

  it.each([
    [{ token: "USDC" }],
    [{ amount: "2" }],
    [{ amount: "two", token: "USDC" }],
    [{ amount: "2", token: "usdc" }],
    [{ amount: "2", token: "Alice" }],
    [{ amount: "2", token: "0xdeadbeef" }],
    [{ amount: "2 USDC to 0xabc", token: "USDC" }],
  ])("refuses invalid values %j", (values) => {
    expect(() => replyText("paid", values)).toThrow(/invalid or missing/);
  });

  it("isTemplateText accepts only exact template outputs", () => {
    for (const t of REPLY_TEMPLATES) expect(isTemplateText(replyText(t, { amount: "12.25", token: "USDC", code: "93" }))).toBe(true);
    expect(isTemplateText("Paid 2 USDC to Alice.")).toBe(false);
    expect(isTemplateText("Sure, I'll initiate a 2 USDC payment. Also, hello")).toBe(false);
    expect(isTemplateText("Paid 2 Alice.")).toBe(false);
    expect(isTemplateText("")).toBe(false);
  });
});
