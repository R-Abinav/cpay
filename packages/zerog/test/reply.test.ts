import { describe, expect, it } from "vitest";
import { REPLY_TEMPLATES, isTemplateText, replyText } from "../src/index.js";

describe("replyText templates", () => {
  it("renders the ack line from docs", () => {
    expect(replyText("ack", { amount: "2", token: "USDC" })).toBe("Sure, I'll initiate a 2 USDC payment.");
  });

  it("renders every template", () => {
    const v = { amount: "1.5", token: "USDC" };
    expect(REPLY_TEMPLATES.map((t) => replyText(t, v))).toEqual([
      "Sure, I'll initiate a 1.5 USDC payment.",
      "That's over your limit. Approve 1.5 USDC on your phone.",
      "Press confirm to pay 1.5 USDC.",
      "Paid 1.5 USDC.",
      "Cancelled. Nothing was paid.",
      "Approval denied. Nothing was paid.",
      "No verified recipient. Nothing was paid.",
      "The voice agent is offline. Nothing was paid.",
      "Nothing found to pay. Press Scan on your phone to try again.",
      "That QR isn't a payment code. Press Scan to try again.",
      "That QR is for another network. Nothing was paid.",
      "Sorry, say the amount again.",
      "Pay 1.5 USDC? Say confirm and the code on your display.",
      "Sorry. Say confirm and the code on your display.",
      "That's over your limit. Approve on your phone.",
      "No verified recipient. Nothing was paid.",
      "Sending privately. This takes about two minutes.",
      "Private payment unavailable. Pay 1.5 USDC publicly? Say confirm and the code.",
      "Recipient not found. Ask them to open CPay Receive, then press Scan.",
      "Payment failed. Nothing was paid. Check your phone.",
      "Want to pay? Say yes to scan.",
      "Okay. Press Scan when you're ready.",
      "Scanning. Look at the QR code or the person you're paying.",
      "QR code found. Say the amount after the beep.",
      "Payment not confirmed yet. Check your phone before paying again.",
    ]);
  });

  it("never carries the one-time confirm code (OLED only, invariant 7)", () => {
    expect(replyText("confirmPrompt", { amount: "2", token: "USDC" })).toBe("Pay 2 USDC? Say confirm and the code on your display.");
    expect(() => replyText("confirmPrompt", { amount: "2", token: "USDC", code: "47" } as never)).toThrow(/unexpected value "code"/);
    expect(() => replyText("confirmAgain", { code: "47" } as never)).toThrow(/unexpected value "code"/);
    expect(() => replyText("confirmPromptPublic", { amount: "2", token: "USDC", code: "47" } as never)).toThrow(/unexpected value "code"/);
    expect(isTemplateText("Pay 2 USDC? Say confirm 47.")).toBe(false);
    expect(isTemplateText("Say confirm 47 again.")).toBe(false);
  });

  it("rejects unknown and prototype template names", () => {
    expect(() => replyText("toString" as never)).toThrow(/unknown reply template/);
  });

  it("templates without placeholders need no values", () => {
    expect(replyText("brainOffline")).toBe("The voice agent is offline. Nothing was paid.");
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
    for (const t of REPLY_TEMPLATES) expect(isTemplateText(replyText(t, { amount: "12.25", token: "USDC" }))).toBe(true);
    expect(isTemplateText("Paid 2 USDC to Alice.")).toBe(false);
    expect(isTemplateText("Sure, I'll initiate a 2 USDC payment. Also, hello")).toBe(false);
    expect(isTemplateText("Paid 2 Alice.")).toBe(false);
    expect(isTemplateText("")).toBe(false);
  });
});
