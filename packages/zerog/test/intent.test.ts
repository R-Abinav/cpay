import { describe, expect, it } from "vitest";
import { intentOutputSchema, validateIntentOutput } from "../src/index.js";

describe("validateIntentOutput (strict JSON -> zod, never guess)", () => {
  it("accepts a well-formed intent and fills only config-owned fields", () => {
    expect(validateIntentOutput('{"amount":"2","token":"USDC"}')).toEqual({
      ok: true,
      intent: { amount: "2", token: "USDC", mode: "lite", recipientRef: "looked-at" },
    });
    expect(validateIntentOutput('{"amount":"1.5","token":"USDC"}', ["USDC"], "full")).toMatchObject({
      ok: true,
      intent: { amount: "1.5", mode: "full" },
    });
  });

  it("tolerates whitespace and a single ```json fence (formatting only)", () => {
    expect(validateIntentOutput('\n```json\n{"amount":"2","token":"USDC"}\n```\n').ok).toBe(true);
  });

  it("maps the model's refusal to model_refused", () => {
    expect(validateIntentOutput('{"refused":true}')).toEqual({ ok: false, reason: "model_refused" });
  });

  it.each([
    ["prose", "Sure! Paying 2 USDC.", "invalid_json"],
    ["prose around JSON", 'Here: {"amount":"2","token":"USDC"}', "invalid_json"],
    ["array", '[{"amount":"2","token":"USDC"}]', "invalid_json"],
    ["null content", null, "invalid_json"],
    ["number amount", '{"amount":2,"token":"USDC"}', "schema_mismatch"],
    ["missing amount", '{"token":"USDC"}', "schema_mismatch"],
    ["missing token", '{"amount":"2"}', "schema_mismatch"],
    ["zero amount", '{"amount":"0","token":"USDC"}', "schema_mismatch"],
    ["negative amount", '{"amount":"-2","token":"USDC"}', "schema_mismatch"],
    ["exponent amount", '{"amount":"2e3","token":"USDC"}', "schema_mismatch"],
    ["too many decimals", '{"amount":"1.0000001","token":"USDC"}', "schema_mismatch"],
    ["leading zero", '{"amount":"02","token":"USDC"}', "schema_mismatch"],
    ["extra field (recipient)", '{"amount":"2","token":"USDC","to":"0xabc"}', "schema_mismatch"],
    ["model-chosen mode", '{"amount":"2","token":"USDC","mode":"full"}', "schema_mismatch"],
    ["refused:false", '{"refused":false}', "schema_mismatch"],
    ["token not allowed", '{"amount":"2","token":"ETH"}', "token_not_allowed"],
    ["lower-case token", '{"amount":"2","token":"usdc"}', "token_not_allowed"],
  ])("refuses %s", (_name, content, reason) => {
    expect(validateIntentOutput(content)).toEqual({ ok: false, reason });
  });

  it("exposes the zod schema with the allow-list", () => {
    expect(intentOutputSchema(["USDC", "EURC"]).safeParse({ amount: "3", token: "EURC" }).success).toBe(true);
  });
});
