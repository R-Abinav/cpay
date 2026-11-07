"use client";
// Browser calls to apps/issuer (contract confirmed with the identity agent):
//   POST /enrol {idkitResult, commitment} -> BlindSignature {signature, tier, epoch} | {error}
//   GET  /issuer-key -> {publicKey}
// TODO: switch to @cpay/world's enrol()/fetchIssuerKey() once the identity branch is merged.
import type { BlindSignature } from "@cpay/credential";
import { z } from "zod";
import { publicConfig } from "./public-config.js";

export class IssuerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BlindSig = z.object({ signature: z.string().min(1), tier: z.string().min(1), epoch: z.string().regex(/^\d{4}-\d{2}$/) });

export async function enrolWithIssuer(issuerUrl: string, idkitResult: unknown, commitment: string): Promise<BlindSignature> {
  if (!issuerUrl) throw new IssuerError(0, "NEXT_PUBLIC_ISSUER_URL is not set");
  let res: Response;
  issuerStats.requests++;
  try {
    res = await fetch(`${issuerUrl}/enrol`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idkitResult, commitment }),
      referrerPolicy: "no-referrer",
    });
  } catch (e) {
    throw new IssuerError(0, `issuer unreachable: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    const hint = msg === "already enrolled" ? " (this World ID already holds a card)" : res.status === 502 ? " (World unreachable)" : "";
    throw new IssuerError(res.status, msg + hint);
  }
  const parsed = BlindSig.safeParse(body);
  if (!parsed.success) throw new IssuerError(res.status, "issuer returned an unexpected shape");
  return parsed.data;
}

/**
 * Get the card back without World App when this passkey's commitment was already World-verified here
 * (World App refuses a second proof for the same action). Null when there is nothing to restore (404).
 */
export async function reissueWithIssuer(issuerUrl: string, commitment: string): Promise<BlindSignature | null> {
  if (!issuerUrl) return null;
  let res: Response;
  issuerStats.requests++;
  try {
    res = await fetch(`${issuerUrl}/reissue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commitment }),
      referrerPolicy: "no-referrer",
    });
  } catch {
    return null; // fall back to World ID; that path reports reachability errors itself
  }
  if (res.status === 404 || res.status === 400) return null;
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) return null;
  const parsed = BlindSig.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** "Delete my account": the issuer deletes its nullifier row for this holder's commitment C. Returns rows removed. */
export async function forgetWithIssuer(issuerUrl: string, commitment: string): Promise<number> {
  if (!issuerUrl) throw new IssuerError(0, "NEXT_PUBLIC_ISSUER_URL is not set");
  let res: Response;
  issuerStats.requests++;
  try {
    res = await fetch(`${issuerUrl}/forget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commitment }),
      referrerPolicy: "no-referrer",
    });
  } catch (e) {
    throw new IssuerError(0, `issuer unreachable: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as { deleted?: unknown; error?: unknown } | null;
  if (!res.ok) throw new IssuerError(res.status, String(body?.error ?? `HTTP ${res.status}`));
  return typeof body?.deleted === "number" ? body.deleted : 0;
}

/** Network requests this page made to the issuer (for the Privacy X-ray). */
export const issuerStats = { requests: 0 };

// ---- issuer BBS public key ------------------------------------------------------------------------------
// Fetched ONCE, at app start (prefetchIssuerPublicKey from the background recipient service), or pinned at
// build time via NEXT_PUBLIC_ISSUER_BBS_PUBLIC_KEY; then cached in memory and in localStorage (it is public).
// A payer verifying a claim reads the cache, so the issuer never sees a key request at the moment someone
// pays and can't line it up (IP + timing) with the recipient's relay activity.

const STORE_KEY = "cpay.issuerKey.v1";
const PublicKeyBody = z.object({ publicKey: z.string().min(1) });
const StoredKey = z.object({ issuerUrl: z.string(), publicKey: z.string().min(1), at: z.number() });
/** Refresh a stored key at most this often (picks up a rotation without a fetch on every app open). */
const REFRESH_MS = 24 * 60 * 60_000;

let keyCache: Promise<string> | null = null;
let inflight: Promise<string> | null = null;

function readStored(issuerUrl: string): { publicKey: string; at: number } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const p = StoredKey.safeParse(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"));
    return p.success && p.data.issuerUrl === issuerUrl ? p.data : null;
  } catch {
    return null;
  }
}

function writeStored(issuerUrl: string, publicKey: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORE_KEY, JSON.stringify({ issuerUrl, publicKey, at: Date.now() }));
  } catch {
    /* storage full / disabled: the in-memory cache still holds it */
  }
}

/** One network fetch of /issuer-key (deduplicated); stores the result. */
function fetchFromIssuer(issuerUrl: string): Promise<string> {
  if (inflight) return inflight;
  issuerStats.requests++;
  inflight = fetch(`${issuerUrl}/issuer-key`, { referrerPolicy: "no-referrer", cache: "no-store" })
    .then(async (r) => {
      if (!r.ok) throw new IssuerError(r.status, `issuer /issuer-key -> ${r.status}`);
      const { publicKey } = PublicKeyBody.parse(await r.json());
      writeStored(issuerUrl, publicKey);
      keyCache = Promise.resolve(publicKey);
      return publicKey;
    })
    .catch((e) => {
      throw e instanceof IssuerError ? e : new IssuerError(0, `issuer unreachable: ${(e as Error).message}`);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The issuer key, cache first: build-time pin, then memory, then localStorage. Only if none of those has it
 * (first ever run, startup prefetch failed) does this go to the network.
 */
export function fetchIssuerPublicKey(issuerUrl: string): Promise<string> {
  if (publicConfig.issuerPublicKey) return Promise.resolve(publicConfig.issuerPublicKey);
  if (!issuerUrl) return Promise.reject(new IssuerError(0, "NEXT_PUBLIC_ISSUER_URL is not set"));
  if (keyCache) return keyCache;
  const stored = readStored(issuerUrl);
  if (stored) return (keyCache = Promise.resolve(stored.publicKey));
  return fetchFromIssuer(issuerUrl);
}

/**
 * Warm the cache at app start (not tied to any payment). A stored key is used as is and refreshed in the
 * background only when older than REFRESH_MS (to pick up a key rotation). Never throws.
 */
export function prefetchIssuerPublicKey(issuerUrl: string = publicConfig.issuerUrl): void {
  if (publicConfig.issuerPublicKey || !issuerUrl) return;
  const stored = readStored(issuerUrl);
  if (stored) keyCache ??= Promise.resolve(stored.publicKey);
  if (stored && Date.now() - stored.at < REFRESH_MS) return;
  fetchFromIssuer(issuerUrl).catch(() => undefined);
}
