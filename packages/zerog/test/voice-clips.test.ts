// The committed voice clips must match reply.ts. If a parameter-free template's text changes, this fails until
// `pnpm --filter @cpay/zerog voice-clips` is re-run (so the earbuds never say outdated words).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIP_TEMPLATES, REPLY_TEMPLATES, hasPlaceholders, templateSource } from "../src/reply.js";

const VOICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/voice");
const manifest = JSON.parse(readFileSync(join(VOICE_DIR, "manifest.json"), "utf8")) as {
  generator: { model: string; voice: string };
  clips: Record<string, { file: string; textSha256: string; bytes: number }>;
};
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("pre-rendered voice clips", () => {
  it("only parameter-free templates get a clip", () => {
    expect(CLIP_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of REPLY_TEMPLATES) expect(CLIP_TEMPLATES.includes(t)).toBe(!hasPlaceholders(t));
    expect(Object.keys(manifest.clips).sort()).toEqual([...CLIP_TEMPLATES].sort());
  });

  it.each(CLIP_TEMPLATES)("%s clip matches the current template text", (t) => {
    const c = manifest.clips[t];
    expect(c, `no clip for ${t}: run pnpm --filter @cpay/zerog voice-clips`).toBeDefined();
    expect(c!.textSha256, `text of ${t} changed: run pnpm --filter @cpay/zerog voice-clips`).toBe(sha256(templateSource(t)));
    const f = join(VOICE_DIR, c!.file);
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBe(c!.bytes);
    expect(c!.bytes).toBeLessThan(60_000); // small enough to preload them all
    const head = readFileSync(f).subarray(0, 3);
    const isMp3 = head.toString("latin1") === "ID3" || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0);
    expect(isMp3).toBe(true);
  });

  it("never carries a value placeholder", () => {
    for (const t of CLIP_TEMPLATES) expect(templateSource(t)).not.toMatch(/\{(amount|token|code)\}/);
  });
});
