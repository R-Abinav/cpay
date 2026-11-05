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
  | "brainOffline"
  | "noQr"
  | "notWalletQr"
  | "wrongNetwork"
  | "sayAmountAgain"
  | "confirmPrompt"
  | "confirmAgain"
  | "approveOnPhone"
  | "noVerifiedRecipient";

/** Decimal string, no sign/exponent, at most 6 decimals (USDC precision). */
export const AMOUNT_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
/** Upper-case token symbol. */
export const TOKEN_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** Spoken one-time confirm code: 2-4 digits (the phone uses 10..99). */
export const CODE_RE = /^[0-9]{2,4}$/;

export interface ReplyValues {
  amount?: string;
  token?: string;
  code?: string;
}

const PLACEHOLDER_RE: Record<keyof ReplyValues, RegExp> = { amount: AMOUNT_RE, token: TOKEN_RE, code: CODE_RE };

const TEMPLATES: Record<ReplyTemplate, string> = {
  ack: "Sure, I'll initiate a {amount} {token} payment.",
  needApproval: "That's over your limit. Approve {amount} {token} on your phone.",
  confirm: "Press confirm to pay {amount} {token}.",
  paid: "Paid {amount} {token}.",
  cancelled: "Cancelled. Nothing was paid.",
  denied: "Approval denied. Nothing was paid.",
  noRecipient: "No verified recipient. Nothing was paid.",
  brainOffline: "Brain offline. Payments paused.",
  noQr: "No QR found.",
  notWalletQr: "That's not a wallet QR.",
  wrongNetwork: "Wrong network. Nothing was paid.",
  sayAmountAgain: "Sorry, say the amount again.",
  confirmPrompt: "Pay {amount} {token}? Say confirm {code}.",
  confirmAgain: "Say confirm {code} again.",
  approveOnPhone: "That's over your limit. Approve on your phone.",
  noVerifiedRecipient: "No verified recipient. Nothing was paid.",
};

export const REPLY_TEMPLATES = Object.keys(TEMPLATES) as ReplyTemplate[];

/** Fixed template replies, filled only with validated numbers. Throws on a missing/invalid value. */
export function replyText(template: ReplyTemplate, values?: ReplyValues): string {
  const t = Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : undefined;
  if (t === undefined) throw new Error(`unknown reply template: ${String(template)}`);
  return t.replace(/\{(amount|token|code)\}/g, (_m, key: keyof ReplyValues) => {
    const v = values?.[key];
    const re = PLACEHOLDER_RE[key];
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
          .replace(escapeRe("{token}"), TOKEN_RE.source.slice(1, -1))
          .replace(escapeRe("{code}"), CODE_RE.source.slice(1, -1)) +
        "$",
    ),
);

/** True only for an exact output of replyText(). speak() refuses anything else. */
export function isTemplateText(text: string): boolean {
  return TEMPLATE_MATCHERS.some((re) => re.test(text));
}
