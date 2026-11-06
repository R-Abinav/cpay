"use client";
// Phone audio for /pay: beep + TTS playback through one AudioContext (unlocked by the Scan tap, which iOS
// needs), and short mic recordings. The mic opens only for a recording and every track stops right after
// (invariant 8). Audio never touches storage.
import { VAD, vadInit, vadStep, type VadVerdict } from "./pay-machine.js";
import { preloadClips } from "./voice-clips.js";

let ctx: AudioContext | null = null;

/** Call from a user gesture (the Scan tap) so later beeps and replies can play on iOS Safari. */
export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx ??= new AC();
  if (ctx.state === "suspended") void ctx.resume();
  preloadClips(); // the fixed voice clips, so the first cue plays without a fetch
}

export function beep(freq = 880, ms = 160): void {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.25, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + ms / 1000);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + ms / 1000);
}

/**
 * Play encoded audio (mp3/wav) and resolve when it ends. `onStart` fires once, the moment sound actually starts
 * (the element's `playing` event, or the Web Audio source start), so the screen can show the same words in sync.
 */
export async function playBytes(bytes: ArrayBuffer, onStart?: () => void, mime = "audio/mpeg"): Promise<void> {
  if (typeof window === "undefined") return;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    onStart?.();
  };
  // Try HTML5 Audio element first as it handles MP3 without AudioContext suspension issues
  try {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    await new Promise<void>((resolve, reject) => {
      audio.onplaying = start;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      audio.play().then(start, reject);
    });
    return;
  } catch (e) {
    // Sound already started (then failed mid-way): don't play it twice.
    if (started) throw e;
    // Fall back to Web Audio API
  }
  if (!ctx) unlockAudio();
  const c = ctx!;
  if (c.state === "suspended") await c.resume();
  const buf = await c.decodeAudioData(bytes.slice(0));
  await new Promise<void>((resolve) => {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.onended = () => resolve();
    src.start();
    start();
  });
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export interface Recording {
  blob: Blob;
  ms: number;
  verdict: VadVerdict | "fixed";
  /** True if the VAD heard anything above threshold. */
  heardSpeech: boolean;
}

/**
 * Record the mic. mode "vad": until ~2 s of quiet after speech, 5 s without speech, or 8 s max.
 * mode "fixed": exactly `ms`. `signal` aborts early (Stop).
 */
export async function record(opts: { mode: "vad" } | { mode: "fixed"; ms: number }, signal?: AbortSignal): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  try {
    const mimeType = MIME_CANDIDATES.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = performance.now();

    // RMS meter for the VAD (and for "heardSpeech" in fixed mode).
    unlockAudio();
    const c = ctx!;
    const srcNode = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 1024;
    srcNode.connect(an);
    const buf = new Float32Array(an.fftSize);
    let vad = vadInit(0);
    let heard = false;

    const verdict = await new Promise<VadVerdict | "fixed">((resolve) => {
      rec.start(200);
      const iv = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
        const rms = Math.sqrt(sum / buf.length);
        if (rms >= VAD.threshold) heard = true;
        const now = performance.now() - started;
        if (signal?.aborted) return finish("stop_max");
        if (opts.mode === "fixed") {
          if (now >= opts.ms) finish("fixed");
          return;
        }
        const [next, v] = vadStep(vad, rms, now);
        vad = next;
        if (v !== "continue") finish(v);
      }, 50);
      function finish(v: VadVerdict | "fixed") {
        clearInterval(iv);
        resolve(v);
      }
    });

    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" }));
      if (rec.state !== "inactive") rec.stop();
      else resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    });
    srcNode.disconnect();
    return { blob, ms: Math.round(performance.now() - started), verdict, heardSpeech: heard };
  } finally {
    stopTracks();
  }
}
