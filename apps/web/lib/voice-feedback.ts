"use client";
// Voice is the feedback; the screen follows it. A spoken reply's fixed template text appears as a toast at the
// exact moment its audio starts playing (not before).
// Order: a parameter-free template plays its pre-rendered local clip at once (no network, no ticket needed:
// fixed text only); templates with {amount}/{token}, or a clip that fails, go to 0G TTS (/api/speak, with
// evidence). If that fails too, the same text shows at once plus a "voice unavailable" error, so nothing
// fails silently and nothing is faked. The confirm code is never a template value (it lives on the OLED only).
import { replyText, type ReplyTemplate } from "@cpay/zerog/reply";
import { toast, type ToastKind } from "./toast.js";
import { loadClip, preloadClipsOnFirstGesture } from "./voice-clips.js";
import { playBytes } from "./voice-io.js";
import { speakAudio, speakParams, type EvidenceLine, type SpeakTemplate } from "./zg-client.js";

preloadClipsOnFirstGesture();

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
  wantToPay: "info",
  notNow: "info",
  scanning: "info",
  qrFound: "info",
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

export type VoiceSource = "clip" | "0g";
export type SayOutcome =
  | { played: true; source: VoiceSource; msToSound: number; evidence: EvidenceLine[] }
  | { played: false; why: string; evidence: EvidenceLine[] };

/** What sayWithToast needs from the outside world (injected so tests can drive every path). */
export interface SayDeps {
  loadClip: (template: SpeakTemplate) => Promise<ArrayBuffer | null>;
  speakAudio: typeof speakAudio;
  playBytes: (bytes: ArrayBuffer, onStart: () => void, mime: string) => Promise<void>;
  showToast: (kind: ToastKind, text: string, link?: { href: string; label: string }) => void;
  showError: (text: string) => void;
  now: () => number;
}

export function createSay(deps: SayDeps) {
  /**
   * Speak a template: local clip first (parameter-free templates), else 0G TTS. The toast appears when sound
   * starts. Resolves when playback ends. `ticket` null = no hub ticket: the 0G path is skipped (ticket-guarded).
   */
  return async function say(
    template: SpeakTemplate,
    params: Record<string, string | number>,
    ticket: string | null,
    opts: { link?: { href: string; label: string }; live?: () => boolean } = {},
  ): Promise<SayOutcome> {
    const t0 = deps.now();
    const text = templateText(template, params);
    let soundAt = -1;
    const show = () => {
      if (soundAt >= 0) return;
      soundAt = deps.now();
      if (text && (opts.live?.() ?? true)) deps.showToast(KIND[template], text, opts.link);
    };
    const fallback = (why: string, evidence: EvidenceLine[] = []): SayOutcome => {
      show();
      deps.showError(VOICE_UNAVAILABLE);
      return { played: false, why, evidence };
    };
    let why = "";
    const clip = text ? await deps.loadClip(template).catch(() => null) : null;
    if (clip) {
      try {
        await deps.playBytes(clip, show, "audio/mpeg");
        return { played: true, source: "clip", msToSound: soundAt - t0, evidence: [] };
      } catch (e) {
        // Sound already started, then broke: don't say it twice, just flag it.
        if (soundAt >= 0) {
          deps.showError(VOICE_UNAVAILABLE);
          return { played: false, why: `clip stopped: ${e instanceof Error ? e.message : String(e)}`, evidence: [] };
        }
        why = "clip failed; ";
      }
    }
    if (!ticket) return fallback(`${why}no hub ticket`);
    const reply = await deps.speakAudio(template, params, ticket);
    if (!reply) return fallback(`${why}0G TTS failed`);
    try {
      await deps.playBytes(reply.audio, show, reply.mime);
      return { played: true, source: "0g", msToSound: soundAt - t0, evidence: reply.evidence };
    } catch (e) {
      return fallback(`${why}could not play: ${e instanceof Error ? e.message : String(e)}`, reply.evidence);
    }
  };
}

/** The app's speaker: local clips, then 0G TTS, then the text + "Voice unavailable". */
export const sayWithToast = createSay({
  loadClip,
  speakAudio,
  playBytes,
  showToast: (kind, text, link) => toast.show(kind, text, link),
  showError: (text) => toast.error(text),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
});
