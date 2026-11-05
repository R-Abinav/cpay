// Fixed spoken replies. These are the ONLY strings that may be sent to TTS (TTS is not private mode):
// no LLM output, no names, no addresses. Values are validated numbers and token symbols only.

export type ReplyTemplate =
  | "ack"
  | "needApproval"
  | "confirm"
  | "paid"
  | "cancelled"
  | "denied"
  | "noRecipient"
  | "brainOffline";

/** Decimal string, no sign/exponent, at most 6 decimals (USDC precision). */
export const AMOUNT_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
/** Upper-case token symbol. */
export const TOKEN_RE = /^[A-Z][A-Z0-9]{1,9}$/;

const TEMPLATES: Record<ReplyTemplate, string> = {
  ack: "Sure, I'll initiate a {amount} {token} payment.",
  needApproval: "That's over your limit. Approve {amount} {token} on your phone.",
  confirm: "Press confirm to pay {amount} {token}.",
  paid: "Paid {amount} {token}.",
  cancelled: "Cancelled. Nothing was paid.",
  denied: "Approval denied. Nothing was paid.",
  noRecipient: "No verified recipient. Nothing was paid.",
  brainOffline: "Brain offline. Payments paused.",
};

export const REPLY_TEMPLATES = Object.keys(TEMPLATES) as ReplyTemplate[];

/** Fixed template replies, filled only with validated numbers. Throws on a missing/invalid value. */
export function replyText(template: ReplyTemplate, values?: { amount?: string; token?: string }): string {
  const t = TEMPLATES[template];
  if (t === undefined) throw new Error(`unknown reply template: ${String(template)}`);
  return t.replace(/\{(amount|token)\}/g, (_m, key: "amount" | "token") => {
    const v = values?.[key];
    const re = key === "amount" ? AMOUNT_RE : TOKEN_RE;
    if (typeof v !== "string" || !re.test(v)) throw new Error(`replyText(${template}): invalid or missing ${key}`);
    return v;
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEMPLATE_MATCHERS: RegExp[] = Object.values(TEMPLATES).map(
  (t) =>
    new RegExp(
      "^" +
        escapeRe(t)
          .replace(escapeRe("{amount}"), AMOUNT_RE.source.slice(1, -1))
          .replace(escapeRe("{token}"), TOKEN_RE.source.slice(1, -1)) +
        "$",
    ),
);

/** True only for an exact output of replyText(). speak() refuses anything else. */
export function isTemplateText(text: string): boolean {
  return TEMPLATE_MATCHERS.some((re) => re.test(text));
}
