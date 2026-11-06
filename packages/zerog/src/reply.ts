// Fixed spoken replies. These are the ONLY strings that may be sent to TTS. TTS runs in STANDARD mode
// (no private provider exists), so the provider sees this text: no LLM output, no names, no addresses.
// Values are a validated amount and token symbol only. The one-time confirm code is NEVER a value here
// (invariant 7: it is shown only on the wearer's OLED); the confirm templates point at the display.

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
  | "noVerifiedRecipient"
  | "sendingPrivately"
  | "confirmPromptPublic"
  | "noMatch"
  | "payFailed"
  | "wantToPay"
  | "notNow"
  | "scanning"
  | "qrFound";

/** Decimal string, no sign/exponent, at most 6 decimals (USDC precision). */
export const AMOUNT_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
/** Upper-case token symbol. */
export const TOKEN_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** The only values a template may carry. There is deliberately no `code`: the confirm code never reaches TTS. */
export interface ReplyValues {
  amount?: string;
  token?: string;
}

const PLACEHOLDER_RE: Record<keyof ReplyValues, RegExp> = { amount: AMOUNT_RE, token: TOKEN_RE };

const TEMPLATES: Record<ReplyTemplate, string> = {
  ack: "Sure, I'll initiate a {amount} {token} payment.",
  needApproval: "That's over your limit. Approve {amount} {token} on your phone.",
  confirm: "Press confirm to pay {amount} {token}.",
  paid: "Paid {amount} {token}.",
  cancelled: "Cancelled. Nothing was paid.",
  denied: "Approval denied. Nothing was paid.",
  noRecipient: "No verified recipient. Nothing was paid.",
  brainOffline: "The voice agent is offline. Nothing was paid.",
  noQr: "No QR code found. Press Scan on your phone to try again.",
  notWalletQr: "That QR isn't a payment code. Press Scan to try again.",
  wrongNetwork: "That QR is for another network. Nothing was paid.",
  sayAmountAgain: "Sorry, say the amount again.",
  confirmPrompt: "Pay {amount} {token}? Say confirm and the code on your display.",
  confirmAgain: "Sorry. Say confirm and the code on your display.",
  approveOnPhone: "That's over your limit. Approve on your phone.",
  noVerifiedRecipient: "No verified recipient. Nothing was paid.",
  sendingPrivately: "Sending privately. This takes about two minutes.",
  confirmPromptPublic: "Private payment unavailable. Pay {amount} {token} publicly? Say confirm and the code.",
  noMatch: "Recipient not found. Ask them to open CPay Receive, then press Scan.",
  payFailed: "Payment failed. Nothing was paid. Check your phone.",
  wantToPay: "Want to pay? Say yes to scan.",
  notNow: "Okay. Press Scan when you're ready.",
  scanning: "Scanning. Look at the QR code.",
  qrFound: "QR code found. Say the amount after the beep.",
};

export const REPLY_TEMPLATES = Object.keys(TEMPLATES) as ReplyTemplate[];

/** The raw template text, placeholders included (used to pre-render and hash the fixed voice clips). */
export function templateSource(template: ReplyTemplate): string {
  if (!Object.hasOwn(TEMPLATES, template)) throw new Error(`unknown reply template: ${String(template)}`);
  return TEMPLATES[template];
}

/** True if the template carries {amount}/{token}. Those always go to 0G TTS at runtime. */
export function hasPlaceholders(template: ReplyTemplate): boolean {
  return /\{(amount|token)\}/.test(templateSource(template));
}

/** Parameter-free templates: pre-rendered once at build time into self-hosted clips (fixed text only). */
export const CLIP_TEMPLATES: ReplyTemplate[] = REPLY_TEMPLATES.filter((t) => !hasPlaceholders(t));

/** Fixed template replies, filled only with a validated amount and token. Throws on a missing/invalid
 * value and on ANY other key (e.g. `code`), so nothing else can be smuggled towards TTS. */
export function replyText(template: ReplyTemplate, values?: ReplyValues): string {
  const t = Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : undefined;
  if (t === undefined) throw new Error(`unknown reply template: ${String(template)}`);
  for (const k of Object.keys(values ?? {}))
    if (!Object.hasOwn(PLACEHOLDER_RE, k)) throw new Error(`replyText(${template}): unexpected value ${JSON.stringify(k)}`);
  return t.replace(/\{(amount|token)\}/g, (_m, key: keyof ReplyValues) => {
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
          .replace(escapeRe("{token}"), TOKEN_RE.source.slice(1, -1)) +
        "$",
    ),
);

/** True only for an exact output of replyText(). speak() refuses anything else. */
export function isTemplateText(text: string): boolean {
  return TEMPLATE_MATCHERS.some((re) => re.test(text));
}
