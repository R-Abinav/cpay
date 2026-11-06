"use client";
// Voice is the feedback; the screen follows it. A spoken reply's fixed template text appears as a toast at the
// exact moment its audio starts playing (not before). If 0G TTS or the hub ticket is unavailable, the same text
// shows at once plus a "voice unavailable" error, so nothing fails silently and nothing is faked.
// The confirm code is never a template value (it lives on the glasses OLED only).
import { replyText, type ReplyTemplate } from "@cpay/zerog/reply";
import { toast, type ToastKind } from "./toast.js";
import { playBytes } from "./voice-io.js";
import { speakAudio, speakParams, type EvidenceLine, type SpeakTemplate } from "./zg-client.js";

const KIND: Record<SpeakTemplate, ToastKind> = {
  ack: "info",
  sayAmountAgain: "info",
  confirmPrompt: "info",
  confirmAgain: "info",
  paid: "success",
  needApproval: "warn",
  noQr: "warn",
  notWalletQr: "warn",
  wrongNetwork: "warn",
  cancelled: "warn",
  denied: "warn",
  noVerifiedRecipient: "error",
  brainOffline: "error",
  sendingPrivately: "info",
  confirmPromptPublic: "warn",
  noMatch: "warn",
  payFailed: "error",
};

export const VOICE_UNAVAILABLE = "Voice unavailable";

/** The fixed words for a template (same text the earbuds hear). Null if the values don't validate. */
export function templateText(template: SpeakTemplate, params: Record<string, string | number> = {}): string | null {
  try {
    return replyText(template as ReplyTemplate, speakParams(params));
  } catch {
    return null;
  }
}

export type SayOutcome = { played: true; evidence: EvidenceLine[] } | { played: false; why: string; evidence: EvidenceLine[] };

/**
 * Fetch 0G TTS for a template and play it; the toast appears when sound starts. Resolves when playback ends.
 * `ticket` null = no hub ticket (voice is ticket-guarded): show the text now.
 */
export async function sayWithToast(
  template: SpeakTemplate,
  params: Record<string, string | number>,
  ticket: string | null,
  opts: { link?: { href: string; label: string }; live?: () => boolean } = {},
): Promise<SayOutcome> {
  const text = templateText(template, params);
  const show = () => {
    if (text && (opts.live?.() ?? true)) toast.show(KIND[template], text, opts.link);
  };
  const fallback = (why: string, evidence: EvidenceLine[] = []): SayOutcome => {
    show();
    toast.error(VOICE_UNAVAILABLE);
    return { played: false, why, evidence };
  };
  if (!ticket) return fallback("no hub ticket");
  const reply = await speakAudio(template, params, ticket);
  if (!reply) return fallback("0G TTS failed");
  try {
    await playBytes(reply.audio, show, reply.mime);
    return { played: true, evidence: reply.evidence };
  } catch (e) {
    return fallback(`could not play: ${e instanceof Error ? e.message : String(e)}`, reply.evidence);
  }
}
