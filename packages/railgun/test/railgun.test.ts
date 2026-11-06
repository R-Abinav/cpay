import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { validateRailgunAddress } from "@railgun-community/wallet";
import {
  deriveRailgunKeys,
  RAILGUN_SMART_WALLET_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  USDC_SEPOLIA,
} from "../src/index.js";

describe("Railgun on Ethereum Sepolia", () => {
  it("derives deterministic 0zk Railgun keys and official 0zk address from seed", () => {
    const seed = keccak256(new Uint8Array([1, 2, 3, 4]));
    const keys = deriveRailgunKeys(seed);

    expect(keys.spendingKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys.viewingKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys.npk).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys.mnemonic.split(" ").length).toBe(12);

    // Official Railgun address check
    expect(keys.railgunAddress.startsWith("0zk1")).toBe(true);
    expect(validateRailgunAddress(keys.railgunAddress)).toBe(true);

    // Deterministic check
    const keys2 = deriveRailgunKeys(seed);
    expect(keys2.railgunAddress).toBe(keys.railgunAddress);
    expect(keys2.mnemonic).toBe(keys.mnemonic);
  });

  it("targets official Ethereum Sepolia contract addresses", () => {
    expect(RAILGUN_SMART_WALLET_SEPOLIA).toBe("0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea");
    expect(USDC_SEPOLIA).toBe("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
    expect(SEPOLIA_CHAIN_ID).toBe(11155111);
  });
});
