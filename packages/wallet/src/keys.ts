// Key derivation: one 32-byte root (passkey PRF output, or the local-mode random root) -> every
// user key, with HKDF-SHA256 and one info string per key (docs/ARCHITECTURE.md onboarding step 3).
// Runs on the device only. Nothing here touches the network or storage.
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { mapHashToField } from "@noble/curves/abstract/modular.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export interface WalletKeys {
  /** secp256k1 secret key of the agent wallet (a plain EOA) */
  agentPrivateKey: `0x${string}`;
  /** 32-byte secp256k1 secret key (stealth spending key) */
  stealthSpend: Uint8Array;
  /** 32-byte secp256k1 secret key (stealth viewing key) */
  stealthView: Uint8Array;
  /** 32 uniform bytes; @cpay/credential maps them into the BBS field */
  bbsHolder: Uint8Array;
  /** 32 uniform bytes; @cpay/credential maps them into the BBS field */
  bbsBlinding: Uint8Array;
  /** 32-byte AES-256-GCM key for 0G episode logs */
  episodeKey: Uint8Array;
  /** 32-byte seed for the Railgun 0zk wallet (@cpay/railgun: BIP-39 entropy -> Kohaku MnemonicKeystore) */
  railgunSeed: Uint8Array;
}

export const INFO = {
  agentWallet: "cpay/v1/agent-wallet",
  stealthSpend: "cpay/v1/stealth-spend",
  stealthView: "cpay/v1/stealth-view",
  bbsHolder: "cpay/v1/bbs-holder",
  bbsBlinding: "cpay/v1/bbs-blinding",
  episode: "cpay/v1/episode",
  railgun: "cpay/v1/railgun",
} as const;

/** PRF salt: sha256("cpay/v1/root"). Changing it changes every user's keys. */
export const PRF_SALT: Uint8Array = sha256(utf8ToBytes("cpay/v1/root"));

const SECP_N = secp256k1.Point.Fn.ORDER;
// 48 bytes for a 256-bit order: the bias of the reduction is negligible (FIPS 186-5 A.2.1).
const SECP_HASH_LEN = 48;

function expand(root: Uint8Array, info: string, len: number): Uint8Array {
  return hkdf(sha256, root, undefined, utf8ToBytes(info), len);
}

/** HKDF -> valid secp256k1 secret key in [1, n-1], using the library's own field mapping. */
function secpKey(root: Uint8Array, info: string): Uint8Array {
  const sk = mapHashToField(expand(root, info, SECP_HASH_LEN), SECP_N);
  if (!secp256k1.utils.isValidSecretKey(sk)) throw new Error("wallet: derived an invalid secp256k1 key");
  return sk;
}

/** Deterministic: the same root always gives the same keys. */
export function deriveKeys(root: Uint8Array): WalletKeys {
  if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error("wallet: root must be 32 bytes");
  return {
    agentPrivateKey: `0x${bytesToHex(secpKey(root, INFO.agentWallet))}`,
    stealthSpend: secpKey(root, INFO.stealthSpend),
    stealthView: secpKey(root, INFO.stealthView),
    bbsHolder: expand(root, INFO.bbsHolder, 32),
    bbsBlinding: expand(root, INFO.bbsBlinding, 32),
    episodeKey: expand(root, INFO.episode, 32),
    railgunSeed: expand(root, INFO.railgun, 32),
  };
}
