"use client";
// Browser calls to apps/issuer (contract confirmed with the identity agent):
//   POST /enrol {idkitResult, commitment} -> BlindSignature {signature, tier, epoch} | {error}
//   GET  /issuer-key -> {publicKey}
// TODO: switch to @cpay/world's enrol()/fetchIssuerKey() once the identity branch is merged.
import type { BlindSignature } from "@cpay/credential";
import { z } from "zod";

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
    const hint = res.status === 409 ? " (this World ID already holds a card)" : res.status === 502 ? " (World unreachable)" : "";
    throw new IssuerError(res.status, msg + hint);
  }
  const parsed = BlindSig.safeParse(body);
  if (!parsed.success) throw new IssuerError(res.status, "issuer returned an unexpected shape");
  return parsed.data;
}

/** Network requests this page made to the issuer (for the Privacy X-ray). */
export const issuerStats = { requests: 0 };

let keyCache: Promise<string> | null = null;
export function fetchIssuerPublicKey(issuerUrl: string): Promise<string> {
  if (!issuerUrl) return Promise.reject(new IssuerError(0, "NEXT_PUBLIC_ISSUER_URL is not set"));
  if (!keyCache) issuerStats.requests++;
  keyCache ??= fetch(`${issuerUrl}/issuer-key`, { referrerPolicy: "no-referrer" })
    .then(async (r) => {
      if (!r.ok) throw new IssuerError(r.status, `issuer /issuer-key -> ${r.status}`);
      const b = z.object({ publicKey: z.string().min(1) }).parse(await r.json());
      return b.publicKey;
    })
    .catch((e) => {
      keyCache = null;
      throw e instanceof IssuerError ? e : new IssuerError(0, `issuer unreachable: ${(e as Error).message}`);
    });
  return keyCache;
}
