// Build-time only: downloads the Railgun circuit artifacts Kohaku needs into
// apps/web/public/railgun-artifacts/ and copies Kohaku's WASM to apps/web/public/railgun/, so the
// browser loads them from OUR origin (CLAUDE.md invariant 10). Both folders are gitignored.
//
// Source is pinned to one commit of the repo the Kohaku WASM hard-codes, and every file is checked
// against its git blob SHA-1 from that commit (artifacts.manifest.json). Existing, matching files
// are kept, so re-runs are cheap.
//
//   pnpm --filter @cpay/railgun artifacts
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../../../apps/web/public");
const outDir = resolve(web, "railgun-artifacts");
const COMMIT = "5dd976e5dbf059daa227819df0d3054c83ccccd9";
const SOURCE = `https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/${COMMIT}/artifacts/`;
const manifest = JSON.parse(readFileSync(resolve(here, "artifacts.manifest.json"), "utf8"));

const gitSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

async function one(rel, [sha, size]) {
  const out = resolve(outDir, rel);
  if (existsSync(out)) {
    const have = readFileSync(out);
    if (have.length === size && gitSha(have) === sha) return "kept";
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(SOURCE + rel, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== size || gitSha(buf) !== sha) throw new Error("hash mismatch");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, buf);
      return "fetched";
    } catch (e) {
      if (attempt >= 4) throw new Error(`${rel}: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const entries = Object.entries(manifest);
const counts = { kept: 0, fetched: 0 };
for (let i = 0; i < entries.length; i += 6) {
  const done = await Promise.all(entries.slice(i, i + 6).map(([rel, m]) => one(rel, m)));
  for (const d of done) counts[d]++;
}

// Kohaku's WASM, same version the bundle imports.
const req = createRequire(import.meta.url);
const lib = req.resolve("@kohaku-eth/railgun");
const wasm = resolve(dirname(lib), "../pkg/index_bg.wasm");
mkdirSync(resolve(web, "railgun"), { recursive: true });
copyFileSync(wasm, resolve(web, "railgun/kohaku_bg.wasm"));

console.log(`railgun artifacts: ${counts.fetched} fetched, ${counts.kept} kept (${entries.length} files); kohaku_bg.wasm copied`);
