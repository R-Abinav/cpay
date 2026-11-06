"use client";
// Pre-rendered voice clips for the PARAMETER-FREE reply templates ("Scanning. Look at the QR code.", ...),
// self-hosted under /voice (generated once at build time by `pnpm --filter @cpay/zerog voice-clips`).
// They play instantly from the phone: no network round trip to a TTS provider. Nothing here talks to a third
// party at runtime (CROPS), and the clips carry only fixed template text, never user data or amounts.
// Templates with {amount}/{token} have no clip and keep going to 0G TTS (with evidence).
import manifest from "../public/voice/manifest.json";

type Clips = Record<string, { file: string; textSha256: string; bytes: number } | undefined>;
const CLIPS = manifest.clips as Clips;

/** Same-origin URL of a template's clip (cache-busted by its text hash), or null if it has none. */
export function clipUrl(template: string): string | null {
  const c = Object.hasOwn(CLIPS, template) ? CLIPS[template] : undefined;
  return c ? `/voice/${c.file}?v=${c.textSha256.slice(0, 12)}` : null;
}

export function hasClip(template: string): boolean {
  return clipUrl(template) !== null;
}

const cache = new Map<string, Promise<ArrayBuffer | null>>();

/** The clip's bytes (fetched once, then served from memory). Null if it has no clip or the fetch failed. */
export function loadClip(template: string): Promise<ArrayBuffer | null> {
  const url = clipUrl(template);
  if (!url || typeof fetch === "undefined") return Promise.resolve(null);
  let p = cache.get(template);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
      .then((b) => {
        if (!b) cache.delete(template); // retry next time instead of caching a failure
        return b;
      });
    cache.set(template, p);
  }
  return p;
}

let preloaded = false;
/** Warm the in-memory cache with every clip (~0.3 MB total). Call after the first user gesture. */
export function preloadClips(): void {
  if (preloaded || typeof window === "undefined") return;
  preloaded = true;
  for (const t of Object.keys(CLIPS)) void loadClip(t);
}

/** Preload on the first tap anywhere (a user gesture, so no data is fetched before the user acts). */
export function preloadClipsOnFirstGesture(): void {
  if (typeof window === "undefined" || preloaded) return;
  window.addEventListener("pointerdown", preloadClips, { once: true, passive: true });
}
