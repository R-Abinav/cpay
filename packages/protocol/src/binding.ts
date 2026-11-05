// bindingDigest = sha256("cpay/v1/binding" || lp(sessionNonce) || lp(lower(destination)) || lp(chainId) || lp(lower(token)) || lp(amount))
// lp(x) = 4-byte big-endian length prefix || UTF-8 bytes of x.
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bytesToHex } from "./encoding.js";

export const BINDING_DOMAIN = "cpay/v1/binding";

export interface BindingFields {
  /** 32-byte lowercase hex, no 0x */
  sessionNonce: string;
  /** 0x-prefixed EVM address (lowercased inside the digest) */
  destination: string;
  chainId: number | bigint;
  /** ERC-20 token address (lowercased inside the digest) */
  token: string;
  /** base units, as a bigint or canonical decimal string */
  amount: bigint | string;
}

export function lp(s: string): Uint8Array {
  const b = utf8ToBytes(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.length, false);
  return concatBytes(len, b);
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function canonicalUint(v: number | bigint | string, name: string): string {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`bindingDigest: ${name} must be a non-negative safe integer`);
    return v.toString(10);
  }
  if (typeof v === "bigint") {
    if (v < 0n) throw new Error(`bindingDigest: ${name} must be non-negative`);
    return v.toString(10);
  }
  if (!DECIMAL.test(v)) throw new Error(`bindingDigest: ${name} must be a canonical decimal string`);
  return v;
}

export function bindingDigest(f: BindingFields): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(f.sessionNonce)) throw new Error("bindingDigest: sessionNonce must be 32-byte lowercase hex");
  if (!/^0x[0-9a-fA-F]{40}$/.test(f.destination)) throw new Error("bindingDigest: bad destination address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(f.token)) throw new Error("bindingDigest: bad token address");
  return sha256(
    concatBytes(
      utf8ToBytes(BINDING_DOMAIN),
      lp(f.sessionNonce),
      lp(f.destination.toLowerCase()),
      lp(canonicalUint(f.chainId, "chainId")),
      lp(f.token.toLowerCase()),
      lp(canonicalUint(f.amount, "amount")),
    ),
  );
}

export function bindingDigestHex(f: BindingFields): string {
  return bytesToHex(bindingDigest(f));
}
