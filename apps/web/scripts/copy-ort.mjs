// Copies the onnxruntime-web WASM runtime into public/ort so it's served from our own origin (CROPS: no CDN).
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "node_modules", "onnxruntime-web", "dist");
const out = join(here, "..", "public", "ort");
mkdirSync(out, { recursive: true });
const files = ["ort.wasm.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
for (const f of files) {
  const src = join(dist, f);
  if (!existsSync(src)) throw new Error(`copy-ort: missing ${src}`);
  copyFileSync(src, join(out, f));
}
console.log(`copy-ort: ${files.length} files -> public/ort`);
