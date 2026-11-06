"use client";
import { useState } from "react";
import { speakAndPlay, type SpeakTemplate } from "../lib/zg-client.js";

const VOICE_DEMOS: { label: string; template: SpeakTemplate; params?: Record<string, string>; desc: string }[] = [
  { label: "Initiate Payment", template: "ack", params: { amount: "2", token: "USDC" }, desc: "Spoken when amount is recognized" },
  { label: "Confirm Prompt", template: "confirmPrompt", params: { amount: "2", token: "USDC" }, desc: "Spoken prompt (code is OLED-only)" },
  { label: "Payment Complete", template: "paid", params: { amount: "2", token: "USDC" }, desc: "Spoken when transaction confirms on Ethereum Sepolia" },
  { label: "Over Limit Approval", template: "needApproval", params: { amount: "50", token: "USDC" }, desc: "Triggered when World Agent Pass is needed" },
  { label: "Say Amount Again", template: "sayAmountAgain", desc: "Spoken if audio was unclear" },
  { label: "No Verified Recipient", template: "noVerifiedRecipient", desc: "Spoken if BBS claim / human proof fails" },
];

export function VoiceAssistant({
  currentTemplate,
  currentParams,
  compact = false,
}: {
  currentTemplate?: SpeakTemplate;
  currentParams?: Record<string, string>;
  compact?: boolean;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function play(template: SpeakTemplate, params?: Record<string, string>) {
    setErr(null);
    setPlaying(template);
    try {
      const ok = await speakAndPlay(template, params ?? {});
      if (!ok) setErr("0G Voice unavailable or failed to play");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Audio error");
    } finally {
      setPlaying(null);
    }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            if (currentTemplate) void play(currentTemplate, currentParams);
            else void play("ack", { amount: "2", token: "USDC" });
          }}
          disabled={playing !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-950/40 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-sky-900/50 disabled:opacity-50"
          title="Play 0G voice audio"
        >
          <span className={`text-sm ${playing ? "animate-pulse text-sky-400" : ""}`}>
            {playing ? "🔊 Speaking…" : "🔊 Speak"}
          </span>
        </button>
        {err && <span className="text-xs text-red-300">{err}</span>}
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-sky-500/30 bg-gradient-to-b from-sky-950/30 to-neutral-900/60 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-500/20 text-sky-300">🔊</span>
          <div>
            <h3 className="font-semibold text-white">0G Voice Assistant</h3>
            <p className="text-xs text-sky-200/80">Physical AI Speech via 0G TTS (minimax-speech-2.8-turbo)</p>
          </div>
        </div>
        {playing && (
          <span className="flex items-center gap-1 rounded-full bg-sky-500/20 px-2.5 py-1 text-xs text-sky-300">
            <span className="inline-block h-2 w-1 animate-pulse bg-sky-400" />
            <span className="inline-block h-3 w-1 animate-pulse bg-sky-300" style={{ animationDelay: "150ms" }} />
            <span className="inline-block h-2 w-1 animate-pulse bg-sky-400" style={{ animationDelay: "300ms" }} />
            <span className="ml-1">Speaking</span>
          </span>
        )}
      </div>

      <p className="mt-3 text-xs text-neutral-400 leading-relaxed">
        Instead of reading silent text messages, CPay uses 0G Physical AI speech to speak payment updates into the wearer&apos;s
        earbuds. Only validated template replies are spoken—the confirm code is never spoken aloud (OLED-only).
      </p>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {VOICE_DEMOS.map((d) => {
          const isThisPlaying = playing === d.template;
          return (
            <button
              key={d.template}
              onClick={() => play(d.template, d.params)}
              disabled={playing !== null}
              className="flex flex-col items-start rounded-xl border border-neutral-800 bg-neutral-900/80 p-3 text-left transition hover:border-sky-500/40 hover:bg-neutral-800/80 disabled:opacity-40"
            >
              <div className="flex w-full items-center justify-between font-medium text-sm text-neutral-200">
                <span>{d.label}</span>
                <span className="text-sky-400">{isThisPlaying ? "▶ Playing" : "▶"}</span>
              </div>
              <span className="mt-1 text-xs text-neutral-400">{d.desc}</span>
            </button>
          );
        })}
      </div>

      {err && <p className="mt-3 text-xs text-red-300">Voice error: {err}</p>}
    </section>
  );
}
