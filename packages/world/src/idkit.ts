// IDKit 4 request helpers for the recipient's onboarding (Proof of Human, action cpay-recipient-v1).
// Source: https://docs.world.org/world-id/idkit/integrate (fetched 5 Nov 2026) + @worldcoin/idkit-core 4.6 types.
// The RP signature is made by the issuer (POST /rp-signature); the signing key never reaches the browser.
import type { RpContext } from "@worldcoin/idkit-core";

export type WorldEnvironment = "staging" | "production";

export const WORLD_ACTION = "cpay-recipient-v1";

export type { RpContext };

export interface IdkitRequestParams {
  appId: string;
  action: string;
  /** commitmentSignal(commitment) from @cpay/credential */
  signal: string;
  environment: WorldEnvironment;
}

/** What the web app needs to start an IDKit request. */
export interface IdkitRequestConfig {
  appId: string;
  action: string;
  signal: string;
  environment: WorldEnvironment;
  /** IDKit 4 `rp_context`, built from the issuer's POST /rp-signature response */
  rpSignature: RpContext;
}

/** The IDKit result, forwarded unchanged to the issuer. */
export type IdkitResult = Record<string, unknown>;

/** Issuer POST /rp-signature response (snake_case as in the IDKit guide). */
export interface RpSignatureResponse {
  rp_id: string;
  sig: string;
  nonce: string;
  created_at: number;
  expires_at: number;
}

/** Issuer POST /enrol 200 response: a BBS blind signature (the @cpay/credential BlindSignature shape). */
export interface EnrolResponse {
  signature: string;
  tier: string;
  epoch: string;
}

export class IssuerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IssuerError";
  }
}

type Fetch = typeof fetch;

async function issuerJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `issuer HTTP ${res.status}`;
    throw new IssuerError(res.status, msg);
  }
  return body as T;
}

function base(issuerUrl: string): string {
  return issuerUrl.replace(/\/+$/, "");
}

/** Fetch a fresh RP signature from the issuer and assemble the request config. */
export async function buildIdkitRequest(
  params: IdkitRequestParams,
  issuerUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<IdkitRequestConfig> {
  const res = await fetchImpl(`${base(issuerUrl)}/rp-signature`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: params.action }),
  });
  const r = await issuerJson<RpSignatureResponse>(res);
  return {
    appId: params.appId,
    action: params.action,
    signal: params.signal,
    environment: params.environment,
    rpSignature: {
      rp_id: r.rp_id,
      nonce: r.nonce,
      created_at: r.created_at,
      expires_at: r.expires_at,
      signature: r.sig,
    },
  };
}

/**
 * The exact object for `IDKit.request(...)` / `useIDKitRequest(...)`. Pair it with
 * `.preset(proofOfHuman({ signal: config.signal }))` from @worldcoin/idkit(-core).
 * allow_legacy_proofs is false: v3 and v4 nullifiers differ, so accepting both would allow two
 * cards per human, and the issuer refuses 3.0 proofs anyway.
 */
export function idkitRequestOptions(config: IdkitRequestConfig): {
  app_id: `app_${string}`;
  action: string;
  rp_context: RpContext;
  allow_legacy_proofs: false;
  environment: WorldEnvironment;
} {
  if (!config.appId.startsWith("app_")) throw new Error("world: appId must start with app_");
  return {
    app_id: config.appId as `app_${string}`,
    action: config.action,
    rp_context: config.rpSignature,
    allow_legacy_proofs: false,
    environment: config.environment,
  };
}

/** POST {issuer}/enrol with the IDKit result unchanged + the BBS commitment. Throws IssuerError on non-2xx. */
export async function enrol(
  issuerUrl: string,
  idkitResult: IdkitResult,
  commitment: string,
  fetchImpl: Fetch = fetch,
): Promise<EnrolResponse> {
  const res = await fetchImpl(`${base(issuerUrl)}/enrol`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idkitResult, commitment }),
  });
  return issuerJson<EnrolResponse>(res);
}

/** GET {issuer}/issuer-key -> the BBS issuer public key (base64). */
export async function fetchIssuerKey(issuerUrl: string, fetchImpl: Fetch = fetch): Promise<string> {
  const r = await issuerJson<{ publicKey: string }>(await fetchImpl(`${base(issuerUrl)}/issuer-key`));
  if (typeof r.publicKey !== "string") throw new IssuerError(502, "issuer returned no public key");
  return r.publicKey;
}
