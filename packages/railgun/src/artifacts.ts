// Self-hosted circuit artifacts (CLAUDE.md invariant 10). The Kohaku WASM hard-codes a GitHub
// prefix for its Groth16 artifacts and fetches them through the global `fetch`. We wrap that fetch
// once so those requests go to our own origin (`artifactsBase`, or NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL
// when set: our own backend host) instead. Every other request passes through untouched. Nothing is logged.

/** The prefix baked into @kohaku-eth/railgun 0.0.1-alpha.31's WASM. */
export const KOHAKU_ARTIFACT_PREFIX =
  "https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/refs/heads/main/artifacts/";

/** Every circuit variant the WASM can ask for (transact NNxMM and POI 03x03 / 13x13). */
export const ARTIFACT_VARIANTS: readonly string[] = [
  ...[1, 2, 3, 4, 5].flatMap((n) => [1, 2, 3, 4, 5].map((m) => `railgun/0${n}x0${m}`)),
  "railgun/poi/03x03",
  "railgun/poi/13x13",
];
export const ARTIFACT_FILES: readonly string[] = ["wasm.br", "matrices.bin.br", "proving_key.bin.br"];

let installedBase: string | null = null;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Absolute base URL (resolves "/railgun-artifacts/" against the page origin in a browser). */
export function resolveBase(base: string): string {
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  const loc = (globalThis as { location?: { href: string } }).location;
  return new URL(withSlash, loc?.href).href;
}

/** Maps a Kohaku artifact URL to our own origin; null for any other URL. */
export function rewriteArtifactUrl(url: string, base: string): string | null {
  if (!url.startsWith(KOHAKU_ARTIFACT_PREFIX)) return null;
  const rel = url.slice(KOHAKU_ARTIFACT_PREFIX.length);
  if (rel.includes("..") || rel.includes("%") || rel.includes("?") || rel.includes("#")) throw new Error("railgun: bad artifact path");
  return new URL(rel, base).href;
}

/** NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL, inlined by Next at build time ("" when unset). */
function configuredArtifactsUrl(): string {
  try {
    return (process.env.NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * The artifact base actually used. `override` (default: NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL) wins over the
 * caller's base, so the ~225 MB of artifacts can be served from our own backend host (e.g. when the web
 * host can't ship them) without changing callers. Empty = the caller's base (same origin). An override
 * must be an absolute https URL (http only for localhost) without query or fragment; anything else throws.
 */
export function artifactsBaseFor(fallback: string, override: string = configuredArtifactsUrl()): string {
  const o = override.trim();
  if (o === "") return fallback;
  let u: URL;
  try {
    u = new URL(o);
  } catch {
    throw new Error("railgun: NEXT_PUBLIC_RAILGUN_ARTIFACTS_URL is not an absolute URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("railgun: artifacts URL must be https");
  if (u.search || u.hash || u.username || u.password) throw new Error("railgun: artifacts URL must be a plain base URL");
  return u.href.endsWith("/") ? u.href : `${u.href}/`;
}

/**
 * Installs the artifact-rewriting fetch wrapper (idempotent). A second call with a different base
 * throws: there is one WASM instance per page.
 */
export function installArtifactFetch(artifactsBase: string): void {
  const base = resolveBase(artifactsBaseFor(artifactsBase));
  if (installedBase !== null) {
    if (installedBase !== base) throw new Error("railgun: artifact base already set to a different origin");
    return;
  }
  const realFetch = globalThis.fetch.bind(globalThis);
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = rewriteArtifactUrl(urlOf(input), base);
    if (target === null) return realFetch(input, init);
    const res = await realFetch(target, { method: "GET", credentials: "same-origin", cache: "force-cache" });
    if (!res.ok) throw new Error(`railgun: artifact not found on our origin (${res.status})`);
    // The WASM (reqwest) parses `response.url`, so the returned Response must carry one. A plain
    // fetch sets it; wrap only if a runtime left it empty.
    if (res.url) return res;
    const copy = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(copy, "url", { value: target });
    return copy;
  };
  globalThis.fetch = wrapped as typeof fetch;
  installedBase = base;
}
