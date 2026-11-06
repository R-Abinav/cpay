import { parseAbi, type Address, type Hex } from "viem";

export const RAILGUN_SMART_WALLET_SEPOLIA: Address = "0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea";
export const USDC_SEPOLIA: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

export const RAILGUN_ABI = parseAbi([
  "struct TokenData { uint8 tokenType; address tokenAddress; uint256 tokenSubID; }",
  "struct ShieldPreimage { bytes32 npk; TokenData token; uint128 value; }",
  "struct ShieldCiphertext { bytes32[3] encryptedBundle; bytes32[2] shieldKey; }",
  "struct ShieldRequest { ShieldPreimage preimage; ShieldCiphertext ciphertext; }",
  "function shield(ShieldRequest[] calldata requests) external",
  "function shieldFee() external view returns (uint256)",
  "function unshieldFee() external view returns (uint256)",
  "function getMerkleRoot() external view returns (bytes32)",
  "function hashCommitment(ShieldPreimage calldata preimage) external pure returns (bytes32)",
  "event Shield(uint256 treeNumber, uint256 startPosition, (bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint128 value)[] preimages, (bytes32[3] encryptedBundle, bytes32[2] shieldKey)[] shieldCiphertext)",
  "event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, (bytes32[3] encryptedBundle, bytes32[2] shieldKey)[] ciphertext)",
  "event Unshield(address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee)"
]);
