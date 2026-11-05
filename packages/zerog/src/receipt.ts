// Per-response TEE signature ("receipt") lookup, per 0g-pc-e2ee protocol/SPEC.md §8:
//   the response carries `ZG-Res-Key: <chatKey>`; the client GETs
//   `<provider>/v1/proxy/signature/{chatKey}` DIRECTLY from the provider's broker (the router does not
//   proxy it) and gets `ChatSignature { text, signature, signing_address, signing_algo }`.
//   text = "<scheme>:<reqH>:<respH>", signer = ecrecover(EIP-191(text), signature), accepted only if it
//   equals the provider's ON-CHAIN teeSignerAddress (never the self-reported signing_address).
//
// What this module does: fetch the signature and recover the signer. What it does NOT do (open
// question for the 0G booth): resolve the provider's broker URL and on-chain teeSignerAddress, and
// recompute reqH/respH. So `recoveredSigner === signing_address` is a consistency check, not a proof.

export interface ChatSignature {
  text: string;
  signature: string;
  signing_address?: string;
  signing_algo?: string;
}

export interface FetchedSignature {
  url: string;
  httpStatus: number;
  /** verbatim body (parsed JSON when possible) */
  raw: unknown;
  signature: ChatSignature | null;
  /** parsed from `text` = "<scheme>:<reqH>:<respH>" */
  scheme: string | null;
  /** ecrecover(EIP-191(text), signature); null if it could not be computed */
  recoveredSigner: string | null;
}

function asChatSignature(v: unknown): ChatSignature | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== "string" || typeof o.signature !== "string") return null;
  return {
    text: o.text,
    signature: o.signature,
    signing_address: typeof o.signing_address === "string" ? o.signing_address : undefined,
    signing_algo: typeof o.signing_algo === "string" ? o.signing_algo : undefined,
  };
}

/** Recover the EIP-191 (personal_sign) signer of `text`. */
export async function recoverSigner(text: string, signature: string): Promise<string | null> {
  const { verifyMessage } = await import("ethers");
  try {
    return verifyMessage(text, signature);
  } catch {
    return null;
  }
}

/** GET `<providerBrokerUrl>/v1/proxy/signature/{resKey}`. Never throws on HTTP errors; diagnostic only. */
export async function fetchResponseSignature(
  providerBrokerUrl: string,
  resKey: string,
  timeoutMs = 8000,
): Promise<FetchedSignature> {
  const url = `${providerBrokerUrl.replace(/\/+$/, "")}/v1/proxy/signature/${encodeURIComponent(resKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  let raw: unknown = body;
  try {
    raw = JSON.parse(body);
  } catch {
    /* keep text */
  }
  const signature = res.ok ? asChatSignature(raw) : null;
  const scheme = signature ? (signature.text.split(":")[0] ?? null) : null;
  const recoveredSigner = signature ? await recoverSigner(signature.text, signature.signature) : null;
  return { url, httpStatus: res.status, raw, signature, scheme, recoveredSigner };
}
