import { type Hex } from "viem";
import { Mnemonic, RailgunEngine, ByteUtils } from "@railgun-community/engine";
import { deriveNodes, WalletNode } from "@railgun-community/engine/key-derivation/wallet-node.js";
import { poseidon } from "@railgun-community/engine/utils/poseidon.js";
import { ed25519 } from "@noble/curves/ed25519";

export interface RailgunWalletKeys {
  mnemonic: string;
  railgunAddress: string;
  spendingKey: Hex;
  viewingKey: Hex;
  masterPublicKey: Hex;
  npk: Hex;
}

/**
 * Derive official Railgun 0zk keys and address deterministically on device
 * from a 32-byte seed (derived from passkey PRF root via HKDF).
 *
 * Keys stay local to the device and produce genuine, checksummed 0zk... addresses
 * matching the official Railgun format.
 */
export function deriveRailgunKeys(seed: Hex | Uint8Array): RailgunWalletKeys {
  const seedBytes = typeof seed === "string"
    ? (seed.startsWith("0x") ? Buffer.from(seed.slice(2), "hex") : Buffer.from(seed, "hex"))
    : Buffer.from(seed);

  // Take 16 bytes (128 bits) of entropy for standard 12-word BIP39 mnemonic
  const entropyHex = seedBytes.subarray(0, 16).toString("hex");
  const mnemonic = Mnemonic.fromEntropy(entropyHex);

  const nodes = deriveNodes(mnemonic, 0, "");

  const spendingKeyPair = nodes.spending.getSpendingKeyPair();
  const spendingPrivateKey = spendingKeyPair.privateKey;
  const spendingPublicKey = spendingKeyPair.pubkey;

  const viewingPrivateKey = ByteUtils.hexStringToBytes((nodes.viewing as any).chainKey);
  const viewingPublicKey = ed25519.getPublicKey(viewingPrivateKey);

  const nullifyingKey = poseidon([ByteUtils.hexToBigInt(Buffer.from(viewingPrivateKey).toString("hex"))]);
  const masterPublicKey = WalletNode.getMasterPublicKey(spendingPublicKey, nullifyingKey);

  const railgunAddress = RailgunEngine.encodeAddress({
    masterPublicKey,
    viewingPublicKey,
  });

  return {
    mnemonic,
    railgunAddress,
    spendingKey: `0x${Buffer.from(spendingPrivateKey).toString("hex")}` as Hex,
    viewingKey: `0x${Buffer.from(viewingPrivateKey).toString("hex")}` as Hex,
    masterPublicKey: `0x${masterPublicKey.toString(16).padStart(64, "0")}` as Hex,
    npk: `0x${nullifyingKey.toString(16).padStart(64, "0")}` as Hex,
  };
}
