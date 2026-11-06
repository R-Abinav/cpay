import { parseAbi, type Address } from "viem";

export const RAILGUN_SMART_WALLET_SEPOLIA: Address = "0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea";
export const USDC_SEPOLIA: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

export const RAILGUN_ABI = parseAbi([
  "struct TokenType { uint8 tokenType; address tokenAddress; uint256 tokenSubID; }",
  "struct ShieldPreimage { bytes32 npk; TokenType token; uint120 value; }",
  "struct ShieldCiphertext { bytes32[3] encryptedBundle; bytes32 shieldKey; }",
  "struct ShieldRequest { ShieldPreimage preimage; ShieldCiphertext ciphertext; }",
  "function shield(ShieldRequest[] calldata requests) external",
  "function shieldFee() external view returns (uint256)",
  "function unshieldFee() external view returns (uint256)",
  "function merkleRoot() external view returns (bytes32)",
  "function treeNumber() external view returns (uint256)",
  "function hashCommitment(ShieldPreimage calldata preimage) external pure returns (bytes32)",
  "function nullifiers(uint256 treeNumber, bytes32 nullifier) external view returns (bool)",
  "event Shield(uint256 treeNumber, uint256 startPosition, ShieldPreimage[] preimages, ShieldCiphertext[] shieldCiphertext)",
  "event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, ShieldCiphertext[] ciphertext)",
  "event Unshield(address to, TokenType token, uint256 amount, uint256 fee)"
]);
