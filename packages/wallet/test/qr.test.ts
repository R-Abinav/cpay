import { describe, expect, it } from "vitest";
import { addressQr, parseQr, type ChainConfig } from "../src/index.js";

const cfg: ChainConfig = {
  chainId: 84532,
  rpcUrl: "http://127.0.0.1:1",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  explorerUrl: "https://sepolia.basescan.org",
};
const USDC = cfg.usdc;
const TO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55 test vector
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const PUB = "ab".repeat(32);

describe("parseQr: CPay", () => {
  it("accepts cpay:1:<uuid>.<64hex> and lowercases", () => {
    expect(parseQr(`cpay:1:${UUID.toUpperCase()}.${PUB.toUpperCase()}`, cfg)).toEqual({ kind: "cpay", peerId: UUID, pub: PUB });
  });
  it("trims whitespace", () => {
    expect(parseQr(`  cpay:1:${UUID}.${PUB}\n`, cfg).kind).toBe("cpay");
  });
  it.each([
    `cpay:2:${UUID}.${PUB}`,
    `cpay:1:${UUID}.${PUB.slice(2)}`,
    `cpay:1:not-a-uuid.${PUB}`,
    `cpay:1:${UUID}`,
  ])("rejects malformed %s", (t) => {
    expect(parseQr(t, cfg)).toEqual({ kind: "unsupported", reason: "not_wallet" });
  });
});

describe("parseQr: plain address", () => {
  it("accepts a checksummed address", () => {
    expect(parseQr(TO, cfg)).toEqual({ kind: "address", to: TO });
  });
  it("accepts all-lowercase and returns the checksummed form", () => {
    expect(parseQr(TO.toLowerCase(), cfg)).toEqual({ kind: "address", to: TO });
  });
  it("accepts all-uppercase hex", () => {
    expect(parseQr("0x" + TO.slice(2).toUpperCase(), cfg)).toEqual({ kind: "address", to: TO });
  });
  it("rejects a mixed-case address with a bad checksum", () => {
    const bad = TO.replace("aAeb", "AAeb");
    expect(parseQr(bad, cfg)).toEqual({ kind: "unsupported", reason: "bad_address" });
  });
  it("rejects a wrong-length address", () => {
    expect(parseQr("0x1234", cfg)).toEqual({ kind: "unsupported", reason: "bad_address" });
  });
});

describe("parseQr: EIP-681", () => {
  it("accepts ethereum:<addr>", () => {
    expect(parseQr(`ethereum:${TO}`, cfg)).toEqual({ kind: "address", to: TO });
  });
  it("accepts ethereum:<addr>@84532", () => {
    expect(parseQr(`ethereum:${TO}@84532`, cfg)).toEqual({ kind: "address", to: TO, chainId: 84532 });
  });
  it("accepts pay- prefix and uppercase scheme", () => {
    expect(parseQr(`ETHEREUM:pay-${TO}@84532`, cfg)).toEqual({ kind: "address", to: TO, chainId: 84532 });
  });
  it("accepts a standard USDC transfer (token target, address= recipient) with amount", () => {
    expect(parseQr(`ethereum:${USDC}@84532/transfer?address=${TO}&uint256=2000000`, cfg)).toEqual({
      kind: "address",
      to: TO,
      token: "USDC",
      amount: "2",
      chainId: 84532,
    });
  });
  it("accepts the reverse order (recipient target, address= token) and scientific uint256", () => {
    expect(parseQr(`ethereum:${TO}/transfer?address=${USDC}&uint256=2.5e6`, cfg)).toEqual({
      kind: "address",
      to: TO,
      token: "USDC",
      amount: "2.5",
    });
  });
  it("accepts a transfer without an amount", () => {
    expect(parseQr(`ethereum:${USDC}/transfer?address=${TO}`, cfg)).toEqual({ kind: "address", to: TO, token: "USDC" });
  });
  it("converts fractional base units", () => {
    const r = parseQr(`ethereum:${USDC}/transfer?address=${TO}&uint256=1`, cfg);
    expect(r).toMatchObject({ amount: "0.000001" });
  });
  it.each(["8453", "1", "11155111", "0x14a34", ""])("rejects chain @%s", (c) => {
    expect(parseQr(`ethereum:${TO}@${c}`, cfg)).toEqual({ kind: "unsupported", reason: "wrong_chain" });
  });
  it("rejects a non-USDC token", () => {
    const other = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    expect(parseQr(`ethereum:${other}/transfer?address=${TO}&uint256=1`, cfg)).toEqual({ kind: "unsupported", reason: "unsupported_token" });
  });
  it("rejects an ETH value request", () => {
    expect(parseQr(`ethereum:${TO}?value=1e18`, cfg)).toEqual({ kind: "unsupported", reason: "unsupported_token" });
  });
  it("accepts value=0", () => {
    expect(parseQr(`ethereum:${TO}?value=0`, cfg)).toEqual({ kind: "address", to: TO });
  });
  it("rejects a bad target address (ENS, bad checksum)", () => {
    expect(parseQr("ethereum:alice.eth", cfg)).toEqual({ kind: "unsupported", reason: "bad_address" });
    expect(parseQr(`ethereum:${TO.replace("aAeb", "AAeb")}`, cfg)).toEqual({ kind: "unsupported", reason: "bad_address" });
  });
  it("rejects a transfer with a missing or bad recipient", () => {
    expect(parseQr(`ethereum:${USDC}/transfer?uint256=1`, cfg)).toEqual({ kind: "unsupported", reason: "bad_address" });
    expect(parseQr(`ethereum:${USDC}/transfer?address=0x12&uint256=1`, cfg)).toEqual({ kind: "unsupported", reason: "bad_address" });
  });
  it("rejects other functions and non-integer amounts", () => {
    expect(parseQr(`ethereum:${USDC}/approve?address=${TO}&uint256=1`, cfg)).toEqual({ kind: "unsupported", reason: "not_wallet" });
    expect(parseQr(`ethereum:${USDC}/transfer?address=${TO}&uint256=1.5`, cfg)).toEqual({ kind: "unsupported", reason: "not_wallet" });
  });
});

describe("parseQr: anything else", () => {
  it.each(["upi://pay?pa=alice@upi&am=10", "https://example.com", "hello", "", "bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"])(
    "rejects %s",
    (t) => {
      expect(parseQr(t, cfg)).toEqual({ kind: "unsupported", reason: "not_wallet" });
    },
  );
});

describe("addressQr", () => {
  it("round-trips through parseQr", () => {
    expect(parseQr(addressQr(cfg, TO, "2.5"), cfg)).toEqual({ kind: "address", to: TO, token: "USDC", amount: "2.5", chainId: 84532 });
    expect(parseQr(addressQr(cfg, TO), cfg)).toEqual({ kind: "address", to: TO, token: "USDC", chainId: 84532 });
  });
});
