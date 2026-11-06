// Pre-render every PARAMETER-FREE reply template to a small self-hosted MP3 with Gemini TTS, so short cues
// ("Scanning", "No QR code found") play instantly from the phone instead of waiting on a TTS round trip.
//
// Privacy: Google only ever sees the fixed template text below, once, at build time. No user data, no amounts,
// no tokens, no confirm codes. Nothing calls Google at runtime (CROPS: no third party in the client).
// Templates with {amount}/{token} are never rendered here; they keep going to 0G TTS (with evidence).
//
// API verified against https://ai.google.dev/gemini-api/docs/speech-generation (now served at
// https://aistudio.google.com/docs/speech-generation): Interactions API, POST /v1beta/interactions,
// header x-goog-api-key, response steps[type=model_output].content[type=audio].data = base64 audio/wav
// (RIFF, 24 kHz, mono, 16-bit PCM). We transcode to MP3 (plays on Android Chrome and iOS Safari) with ffmpeg.
//
// The free tier allows only ~10 TTS requests per day, so several templates are read in ONE request (one per
// line, with a pause between lines) and the audio is split at the longest pauses. The split is checked
// (pause margin + duration per character) and a batch that doesn't split cleanly is retried in halves.
//
// Usage: pnpm --filter @cpay/zerog voice-clips [-- --force]
// Key: GEMINI_API_KEY_VOICE_FEEDBACK from the environment or apps/web/.env (never printed, never shipped).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLIP_TEMPLATES, templateSource, type ReplyTemplate } from "../src/reply.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const OUT_DIR = join(REPO, "apps/web/public/voice");
const MANIFEST = join(OUT_DIR, "manifest.json");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = "gemini-3.8-flash-lite-tts";
const VOICE = "Erinome"; // docs: "Clear"
const STYLE = "calm and clear; read each line as a separate short announcement, with a two-second silence between lines";
const FORMAT = "audio/mpeg; mono 24 kHz 48 kbps, silence trimmed";
const BATCH = 5;

interface ClipEntry {
  file: string;
  textSha256: string;
  bytes: number;
}
interface Manifest {
  generator: { model: string; voice: string; style: string; format: string; docs: string };
  clips: Record<string, ClipEntry>;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function apiKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY_VOICE_FEEDBACK;
  if (fromEnv) return fromEnv.trim();
  const envFile = join(REPO, "apps/web/.env");
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, "utf8").match(/^GEMINI_API_KEY_VOICE_FEEDBACK=(.*)$/m);
    const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (v) return v;
  }
  throw new Error("GEMINI_API_KEY_VOICE_FEEDBACK is not set (env or apps/web/.env)");
}

async function synthesize(key: string, text: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: MODEL,
        input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: VOICE }] },
      }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const after = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(after) && after > 0 ? after * 1000 : 15000 * attempt;
      if (ms > 120_000) throw new Error(`Gemini TTS quota exhausted (retry in ${Math.round(ms / 3600_000)} h)`);
      console.log(`[voice-clips] HTTP ${res.status}, retrying in ${Math.round(ms / 1000)} s`);
      await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini TTS HTTP ${res.status}`);
    const j = (await res.json()) as { steps?: { type?: string; content?: { type?: string; data?: string }[] }[] };
    const audio = (j.steps ?? [])
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "audio" && typeof c.data === "string")
      .at(-1);
    if (!audio?.data) throw new Error("Gemini TTS: no audio in response");
    return Buffer.from(audio.data, "base64");
  }
}

interface Pcm {
  rate: number;
  samples: Int16Array;
}

/** Parse a RIFF/WAVE file holding mono 16-bit PCM (what the docs say Gemini returns). */
export function parseWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let off = 12;
  let rate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      const fmt = buf.readUInt16LE(body);
      const ch = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (fmt !== 1 || ch !== 1 || bits !== 16) throw new Error(`unexpected WAV format ${fmt}/${ch}ch/${bits}bit`);
    } else if (id === "data") {
      if (!rate) throw new Error("WAV data before fmt");
      // Streaming-style writers may leave the size as 0/0xffffffff: take the rest of the file.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      const pcm = new Int16Array(Math.floor(size / 2));
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(body + i * 2);
      return { rate, samples: pcm };
    }
    off = body + size + (size & 1);
  }
  throw new Error("WAV without data chunk");
}

export function wavBytes({ rate, samples }: Pcm): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i]!, 44 + i * 2);
  return b;
}

const WIN_S = 0.01;
const SILENT_DBFS = -45;

/** Silent stretches between speech, as [startSample, endSample), from 10 ms RMS windows. */
function pauses({ rate, samples }: Pcm): { start: number; end: number }[] {
  const win = Math.round(rate * WIN_S);
  const thr = 32768 * 10 ** (SILENT_DBFS / 20);
  const loud: boolean[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let k = i; k < i + win; k++) s += samples[k]! * samples[k]!;
    loud.push(Math.sqrt(s / win) >= thr);
  }
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  const out: { start: number; end: number }[] = [];
  for (let w = first; w <= last; w++) {
    if (loud[w]) continue;
    const s = w;
    while (w <= last && !loud[w]) w++;
    out.push({ start: s * win, end: w * win });
  }
  return out;
}

/** Split one batch recording into one segment per line, or null if the pauses don't separate cleanly. */
export function splitBatch(pcm: Pcm, lines: string[]): Pcm[] | null {
  if (lines.length === 1) return [pcm];
  const gaps = pauses(pcm).sort((a, b) => b.end - b.start - (a.end - a.start));
  const cut = gaps.slice(0, lines.length - 1);
  if (cut.length < lines.length - 1) return null;
  const len = (g: { start: number; end: number }) => (g.end - g.start) / pcm.rate;
  const shortestCut = len(cut.at(-1)!);
  const longestKept = gaps[lines.length - 1] ? len(gaps[lines.length - 1]!) : 0;
  if (shortestCut < 0.6 || shortestCut - longestKept < 0.15) return null;
  const bounds = cut.map((g) => Math.round((g.start + g.end) / 2)).sort((a, b) => a - b);
  const edges = [0, ...bounds, pcm.samples.length];
  const segs = lines.map((_, i) => ({ rate: pcm.rate, samples: pcm.samples.slice(edges[i]!, edges[i + 1]!) }));
  // Each segment's speech time should be roughly proportional to its line's length.
  const speech = segs.map((s) => s.samples.length / s.rate);
  const perChar = speech.map((d, i) => d / lines[i]!.length);
  const avg = speech.reduce((a, b) => a + b, 0) / lines.reduce((a, l) => a + l.length, 0);
  if (perChar.some((p) => p < avg * 0.5 || p > avg * 2)) return null;
  return segs;
}

export function toMp3(wav: Buffer): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      // Trim silence at both ends (reverse trick), so sound starts the moment playback starts.
      "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,apad=pad_dur=0.08",
      "-ac", "1", "-ar", "24000",
      "-c:a", "libmp3lame", "-b:a", "48k",
      "-map_metadata", "-1",
      "-f", "mp3", "pipe:1",
    ]);
    const out: Buffer[] = [];
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.on("error", fail);
    ff.on("close", (code) => (code === 0 ? ok(Buffer.concat(out)) : fail(new Error(`ffmpeg exited ${code}`))));
    ff.stdin.end(wav);
  });
}

async function render(key: string, batch: ReplyTemplate[]): Promise<Map<ReplyTemplate, Buffer>> {
  const lines = batch.map((t) => templateSource(t));
  const t0 = Date.now();
  const pcm = parseWav(await synthesize(key, lines.join("\n\n")));
  const segs = splitBatch(pcm, lines);
  if (!segs) {
    console.log(`[voice-clips] batch [${batch.join(", ")}] did not split cleanly; retrying in halves`);
    const mid = Math.ceil(batch.length / 2);
    const a = await render(key, batch.slice(0, mid));
    const b = await render(key, batch.slice(mid));
    return new Map([...a, ...b]);
  }
  const out = new Map<ReplyTemplate, Buffer>();
  for (let i = 0; i < batch.length; i++) out.set(batch[i]!, await toMp3(wavBytes(segs[i]!)));
  console.log(`[voice-clips] rendered [${batch.join(", ")}] in ${Date.now() - t0} ms`);
  return out;
}

async function main() {
  const force = process.argv.includes("--force");
  mkdirSync(OUT_DIR, { recursive: true });
  const prev: Manifest | null = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest) : null;
  const sameVoice = prev?.generator.model === MODEL && prev.generator.voice === VOICE && prev.generator.style === STYLE;
  const manifest: Manifest = {
    generator: { model: MODEL, voice: VOICE, style: STYLE, format: FORMAT, docs: "https://ai.google.dev/gemini-api/docs/speech-generation" },
    clips: {},
  };
  const todo: ReplyTemplate[] = [];
  for (const t of CLIP_TEMPLATES) {
    const old = prev?.clips[t];
    if (!force && sameVoice && old?.textSha256 === sha256(templateSource(t)) && existsSync(join(OUT_DIR, old.file))) manifest.clips[t] = old;
    else todo.push(t);
  }
  console.log(`[voice-clips] ${CLIP_TEMPLATES.length - todo.length} up to date, ${todo.length} to render`);
  const save = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  if (todo.length) {
    const key = apiKey();
    for (let i = 0; i < todo.length; i += BATCH) {
      for (const [t, mp3] of await render(key, todo.slice(i, i + BATCH))) {
        const file = `${t}.mp3`;
        writeFileSync(join(OUT_DIR, file), mp3);
        manifest.clips[t] = { file, textSha256: sha256(templateSource(t)), bytes: mp3.length };
        console.log(`[voice-clips]   ${t}: ${mp3.length} B`);
      }
      save(); // a quota stop keeps what was rendered (same model/voice), so the next run resumes
    }
  }
  // Stable key order (reply.ts order) so the manifest diff stays readable.
  manifest.clips = Object.fromEntries(CLIP_TEMPLATES.filter((t) => manifest.clips[t]).map((t) => [t, manifest.clips[t]!]));
  save();
  const total = Object.values(manifest.clips).reduce((n, c) => n + c.bytes, 0);
  console.log(`[voice-clips] ${Object.keys(manifest.clips).length}/${CLIP_TEMPLATES.length} clips, ${total} B total`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e: unknown) => {
  console.error(`[voice-clips] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
