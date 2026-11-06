// pnpm --filter @cpay/zerog smoke [--storage]
//
// One REAL call of each kind against the 0G router (speak, transcribe, intent), printing request IDs,
// receipts, ALL raw response headers and the verbatim x_0g_trace. Its output tells us where the receipt
// lives. Needs ZG_ROUTER_API_KEY (+ ZG_TTS_VOICE) in the repo-root .env. Nothing here is faked: if a
// call fails, the failure (and its evidence) is what gets printed.
//
// Optional:
//   ZG_SMOKE_AUDIO=/path/clip.webm   transcribe this file instead of the TTS output
//   ZG_PROVIDER_BROKER_URL=https://…  try GET <broker>/v1/proxy/signature/{ZG-Res-Key} (SPEC §8)
//   --storage                         also upload an encrypted smoke episode to 0G Storage (needs ZG_STORAGE_PRIVATE_KEY)

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZeroGUnavailable,
  createRouterClientFromEnv,
  fetchResponseSignature,
  logEpisode,
  replyText,
  storageOptionsFromEnv,
  type Evidence,
  type RawResponseInfo,
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const env = process.env;
const baseUrl = (env.ZG_ROUTER_BASE_URL || "https://router-api.0g.ai/v1").replace(/\/+$/, "");
const evidencePath = resolve(repoRoot, env.ZG_EVIDENCE_PATH || "./data/zerog-evidence.jsonl");
env.ZG_EVIDENCE_PATH = evidencePath;

const hr = (title: string) => console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`);
const dump = (label: string, v: unknown) => console.log(`${label}: ${JSON.stringify(v, null, 2)}`);

if (!env.ZG_ROUTER_API_KEY || env.ZG_ROUTER_API_KEY === "sk-") {
  console.error("ZG_ROUTER_API_KEY is not set. Add it to the repo-root .env (see .env.example), then rerun.");
  process.exit(1);
}

// --- preflight: public model + provider listing (no key needed) ---------------------------------
hr("preflight: models and provider trust tiers (GET /models, /providers)");
const wanted = [
  { role: "stt", id: env.ZG_STT_MODEL || "whisper-large-v3", trust: env.ZG_TRUST_MODE || "private" },
  { role: "intent", id: env.ZG_INTENT_MODEL || "glm-5.3", trust: env.ZG_INTENT_TRUST_MODE || env.ZG_TRUST_MODE || "private" },
  { role: "tts", id: env.ZG_TTS_MODEL || "minimax-speech-2.8-turbo", trust: env.ZG_TTS_TRUST_MODE || "standard" },
];
const rank: Record<string, number> = { standard: 0, verified: 1, private: 2 };
for (const w of wanted) {
  try {
    const res = await fetch(`${baseUrl}/providers?canonical_id=${encodeURIComponent(w.id)}`, { signal: AbortSignal.timeout(15000) });
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = body.data ?? [];
    const tiers = rows.map((p) => `${String(p.address)}/${String(p.provider_identity ?? "-")}:${String(p.trust_mode)}`);
    const ok = rows.some((p) => (rank[String(p.trust_mode)] ?? -1) >= (rank[w.trust] ?? 0));
    console.log(`${w.role.padEnd(6)} ${w.id} wants>=${w.trust} providers=[${tiers.join(", ")}] ${ok ? "OK" : "!! NO PROVIDER AT THIS TIER (expect 503)"}`);
  } catch (e) {
    console.log(`${w.role} ${w.id}: provider lookup failed (${(e as Error).message})`);
  }
}

// --- the three real calls ------------------------------------------------------------------------
const results: Evidence[] = [];
let failures = 0;
const printRaw = (info: RawResponseInfo) => {
  console.log(`HTTP ${info.status}`);
  dump("ALL response headers", info.headers);
  dump("x_0g_trace (verbatim)", info.trace);
};
const zg = createRouterClientFromEnv(env, { evidencePath, onRawResponse: printRaw });
console.log(
  `keys: stt+intent on ZG_ROUTER_API_KEY; tts on ${env.ZG_TTS_API_KEY && env.ZG_TTS_API_KEY !== "sk-" ? "ZG_TTS_API_KEY (separate standard-mode key)" : "ZG_ROUTER_API_KEY (no ZG_TTS_API_KEY set)"}`,
);

async function step<T extends { evidence: Evidence }>(name: string, fn: () => Promise<T>): Promise<T | null> {
  hr(name);
  try {
    const r = await fn();
    results.push(r.evidence);
    dump("evidence", r.evidence);
    return r;
  } catch (e) {
    failures++;
    if (e instanceof ZeroGUnavailable) {
      console.log(`SAFE-STOP: ${e.message}`);
      if (e.evidence) {
        results.push(e.evidence);
        dump("evidence", e.evidence);
      }
    } else {
      console.log(`ERROR: ${(e as Error).message}`);
    }
    return null;
  }
}

const ackText = replyText("ack", { amount: "2", token: "USDC" });
const spoken = await step("speak (TTS of the ack template)", () => zg.speak(ackText));
let audio: Uint8Array | null = null;
let audioName = "ack.mp3";
let audioIsTemplate = true;
if (spoken) {
  audio = new Uint8Array(spoken.audio);
  const out = resolve(repoRoot, "data/smoke-ack.mp3");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, audio);
  console.log(`audio: ${spoken.mime}, ${audio.byteLength} bytes -> ${out}`);
}
if (env.ZG_SMOKE_AUDIO) {
  const p = isAbsolute(env.ZG_SMOKE_AUDIO) ? env.ZG_SMOKE_AUDIO : resolve(repoRoot, env.ZG_SMOKE_AUDIO);
  audio = new Uint8Array(await readFile(p));
  audioName = basename(p);
  audioIsTemplate = false;
}

let transcript = "Hey Pay, pay her 2 USDC";
if (audio) {
  const heard = await step(`transcribe (${audioName})`, () => zg.transcribe(audio!, { filename: audioName }));
  if (heard) {
    transcript = heard.text;
    // Only our own template audio is printed verbatim; a real recording is never logged.
    console.log(audioIsTemplate ? `transcript: ${JSON.stringify(heard.text)}` : `transcript: <${heard.text.length} chars, not printed>`);
  }
} else {
  hr("transcribe");
  console.log("skipped: no audio (TTS failed and ZG_SMOKE_AUDIO is not set)");
}

const intent = await step("intent", () => zg.parseIntent(transcript));
if (intent) dump("intent result", intent.refused ? { refused: true, reason: intent.reason } : intent.intent);

// --- optional: fetch the provider's per-response signature (SPEC §8) -----------------------------
const broker = env.ZG_PROVIDER_BROKER_URL;
for (const ev of results) {
  if (!ev.receipt?.resKey) continue;
  if (!broker) {
    console.log(`\n(${ev.kind}: ZG-Res-Key=${ev.receipt.resKey}; set ZG_PROVIDER_BROKER_URL to fetch its signature)`);
    continue;
  }
  hr(`signature for ${ev.kind} (ZG-Res-Key ${ev.receipt.resKey})`);
  try {
    const sig = await fetchResponseSignature(broker, ev.receipt.resKey);
    dump("signature lookup", sig);
  } catch (e) {
    console.log(`signature lookup failed: ${(e as Error).message}`);
  }
}

// --- optional: encrypted smoke episode on 0G Storage ----------------------------------------------
if (process.argv.includes("--storage")) {
  hr("0G Storage: encrypted smoke episode");
  try {
    const so = storageOptionsFromEnv({ ...env, ZG_EVIDENCE_PATH: evidencePath });
    const r = await logEpisode(
      {
        decision: "smoke-test",
        requestIds: results.map((e) => e.requestId).filter((x): x is string => !!x),
        receipts: results.map((e) => e.receipt),
        txHash: null,
        timestamps: { smoke: new Date().toISOString() },
        policyResult: null,
      },
      new Uint8Array(randomBytes(32)),
      so,
    );
    results.push(r.evidence);
    dump("storage", { rootHash: r.rootHash, txHash: r.txHash });
  } catch (e) {
    failures++;
    console.log(`storage FAILED: ${(e as Error).message}`);
  }
}

// --- summary, ready to paste into EVIDENCE.md ------------------------------------------------------
hr("summary (paste into packages/zerog/EVIDENCE.md)");
for (const e of results) {
  const tv = e.receipt?.teeVerified;
  console.log(
    `| ${e.ts} | ${e.kind} | ${e.model} | ${e.trustMode} | ${e.httpStatus ?? "-"} | ${e.requestId ?? "-"} | ${e.receipt?.resKey ?? "-"} | ${tv === undefined || tv === null ? "absent" : String(tv)} | ${e.rootHash ?? "-"} | ${e.txHash ?? "-"} |`,
  );
}
console.log(`\nevidence JSONL: ${evidencePath}`);
process.exit(failures ? 1 : 0);
