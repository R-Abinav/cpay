// Intent: the model PROPOSES {amount, token}. Strict JSON validated with zod.
// Anything that does not validate is a refusal. We never repair, coerce or guess a value.

import { z } from "zod";
import { AMOUNT_RE } from "./reply.js";

// `mode` (lite/full) comes from config, never from the model.

export interface Intent {
  /** decimal string, e.g. "2" */
  amount: string;
  token: string;
  mode: "lite" | "full";
  recipientRef: "looked-at";
}

/** Fixed refusal codes. Model free text never leaves this module. */
export type RefusalReason =
  | "model_refused" // the model answered {"refused": true}
  | "invalid_json" // the output is not a single JSON object
  | "schema_mismatch" // wrong/extra fields, bad amount format, zero amount
  | "token_not_allowed"; // token outside the allow-list

export const DEFAULT_TOKEN_ALLOW_LIST = ["USDC"] as const;

export function intentSystemPrompt(allowList: readonly string[]): string {
  return [
    "You turn ONE spoken payment command into JSON for a payment agent. The speaker is looking at the recipient,",
    'so "her", "him", "them" or "this person" always mean the person being looked at.',
    "Reply with ONLY a JSON object: no prose, no markdown, no code fences.",
    'If the command clearly asks to pay/send money to that person, reply {"amount":"<amount>","token":"<TOKEN>"}:',
    '- amount: the spoken amount as a decimal string in digits ("two" -> "2", "one point five" -> "1.5"), greater than zero, at most 6 decimals.',
    `- token: exactly one of ${allowList.map((t) => JSON.stringify(t)).join(", ")}, upper case.`,
    'Otherwise reply {"refused":true}. That includes: not a payment command, a missing or unclear amount,',
    "a missing token or one not in the list, more than one payment, or a named third party instead of the looked-at person.",
    "Never guess or fill in a missing value.",
  ].join("\n");
}

export function intentOutputSchema(allowList: readonly string[]) {
  return z
    .object({
      amount: z
        .string()
        .regex(AMOUNT_RE)
        .refine((a) => Number(a) > 0, "amount must be > 0"),
      token: z.string(),
    })
    .strict()
    .refine((o) => allowList.includes(o.token), { message: "token_not_allowed", path: ["token"] });
}

const RefusedSchema = z.object({ refused: z.literal(true) }).strict();

export type IntentValidation = { ok: true; intent: Intent } | { ok: false; reason: RefusalReason };

/**
 * Validate the raw model `content`. Accepts exactly one JSON object, optionally wrapped in a single
 * ```json fence (a formatting wrapper, not content). Everything else is a refusal.
 */
export function validateIntentOutput(
  content: unknown,
  allowList: readonly string[] = DEFAULT_TOKEN_ALLOW_LIST,
  mode: "lite" | "full" = "lite",
): IntentValidation {
  if (typeof content !== "string") return { ok: false, reason: "invalid_json" };
  let s = content.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = (fence[1] ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "invalid_json" };
  if (RefusedSchema.safeParse(parsed).success) return { ok: false, reason: "model_refused" };
  const r = intentOutputSchema(allowList).safeParse(parsed);
  if (!r.success) {
    const tokenIssue = r.error.issues.some((i) => i.message === "token_not_allowed");
    return { ok: false, reason: tokenIssue ? "token_not_allowed" : "schema_mismatch" };
  }
  return {
    ok: true,
    intent: { amount: r.data.amount, token: r.data.token, mode, recipientRef: "looked-at" },
  };
}
