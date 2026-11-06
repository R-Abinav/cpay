import { encodePacked, keccak256, type Hex } from "viem";

export interface RailgunWalletKeys {
  spendingKey: Hex;
  viewingKey: Hex;
  npk: Hex;
  railgunAddress: string;
}

/**
 * Derive Railgun 0zk keys deterministically on this phone.
 * The keys stay local and never leave the device.
 */
export function deriveRailgunKeys(seed: Hex | Uint8Array): RailgunWalletKeys {
  const seedHex = typeof seed === "string" ? seed : (`0x${Array.from(seed).map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex);
  
  const spendingKey = keccak256(encodePacked(["string", "bytes32"], ["cpay/v1/railgun/spending", seedHex]));
  const viewingKey = keccak256(encodePacked(["string", "bytes32"], ["cpay/v1/railgun/viewing", seedHex]));
  const npk = keccak256(encodePacked(["string", "bytes32", "bytes32"], ["cpay/v1/railgun/npk", spendingKey, viewingKey]));
  
  const railgunAddress = `0zk1q${spendingKey.slice(2, 22)}${viewingKey.slice(2, 22)}`;

  return {
    spendingKey,
    viewingKey,
    npk,
    railgunAddress,
  };
}
