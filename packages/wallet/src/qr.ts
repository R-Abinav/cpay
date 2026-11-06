// QR parsing (docs/ARCHITECTURE.md "QR formats"). Pure; runs on the phone on every decoded QR.
import { parseMetaAddress } from "@cpay/stealth";
import { getAddress, isAddress } from "viem";
import { fromBaseUnits, toBaseUnits, type Token } from "./amount.js";
import type { ChainConfig } from "./chain.js";

export type QrResult =
  /** Online CPay QR: the recipient's relay peer + the per-display secret the quote must echo. */
  | { kind: "cpay"; peerId: string; pub: string; qrSecret: string }
  /**
   * Offline CPay QR (opt-in): the recipient's ERC-5564 meta-address. The payer derives a one-time address itself and
   * announces it on chain. No proof: "private · not verified".
   */
  | { kind: "offline"; metaAddress: string }
  | { kind: "address"; to: `0x${string}`; amount?: string; token?: Token; chainId?: number }
  | { kind: "unsupported"; reason: "not_wallet" | "wrong_chain" | "bad_address" | "unsupported_token" };

// Case-insensitive: the app prints it upper-cased (QR alphanumeric mode); everything is lower-cased here.
// The pre-secret form `cpay:1:<peerId>.<pub>` is rejected: such a QR can't be answered any more.
const CPAY = /^cpay:1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})\.([0-9a-f]{32})$/i;
// cpay:2:<spendPub(33 bytes)><viewPub(33 bytes)> as 132 hex, both compressed secp256k1 points.
const CPAY_OFFLINE = /^cpay:2:([0-9a-f]{132})$/i;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

const unsupported = (reason: Extract<QrResult, { kind: "unsupported" }>["reason"]): QrResult => ({ kind: "unsupported", reason });

/** Checksummed address, or null. Mixed case must carry a valid EIP-55 checksum. */
function checkAddress(s: string): `0x${string}` | null {
  if (!HEX_ADDR.test(s)) return null;
  const body = s.slice(2);
  // Single-case hex carries no checksum (EIP-55); mixed case must checksum.
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && !isAddress(s, { strict: true })) return null;
  return getAddress(s.toLowerCase());
}

/** EIP-681 uint256: integer, optionally in scientific notation ("2e6", "2.5e6"). */
function parseUint(s: string): bigint | null {
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  const m = /^([0-9]+)(?:\.([0-9]+))?[eE]([0-9]+)$/.exec(s);
  if (!m) return null;
  const int = m[1] ?? "";
  const frac = m[2] ?? "";
  const exp = Number(m[3]);
  if (exp > 77 || frac.length > exp) return null; // non-integer or absurd
  return BigInt(int + frac + "0".repeat(exp - frac.length));
}

function parseEthereumUri(text: string, cfg: ChainConfig): QrResult {
  let rest = text.slice("ethereum:".length);
  if (rest.startsWith("pay-")) rest = rest.slice(4);
  const m = /^([^@/?]+)(?:@([^/?]*))?(?:\/([^?]*))?(?:\?(.*))?$/.exec(rest);
  if (!m) return unsupported("not_wallet");
  const [, target = "", chainPart, fn, query = ""] = m;

  let chainId: number | undefined;
  if (chainPart !== undefined) {
    if (!/^[0-9]{1,15}$/.test(chainPart)) return unsupported("wrong_chain");
    chainId = Number(chainPart);
    if (chainId !== cfg.chainId) return unsupported("wrong_chain");
  }

  const targetAddr = checkAddress(target);
  if (!targetAddr) return unsupported("bad_address");

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return unsupported("not_wallet");
  }
  const usdc = cfg.usdc.toLowerCase();
  const withChain = (r: Extract<QrResult, { kind: "address" }>): QrResult => (chainId !== undefined ? { ...r, chainId } : r);

  if (fn === undefined || fn === "") {
    // Plain "pay this address" request. A non-zero native `value` asks for ETH, which we don't send.
    const value = params.get("value");
    if (value !== null && parseUint(value) !== 0n) return unsupported("unsupported_token");
    return withChain({ kind: "address", to: targetAddr });
  }
  if (fn !== "transfer") return unsupported("not_wallet");

  // Standard EIP-681: target = token contract, `address` = recipient. The reverse order (target =
  // recipient, `address` = token) is also accepted because some generators emit it.
  const param = params.get("address");
  const paramAddr = param === null ? null : checkAddress(param);
  if (!paramAddr) return unsupported("bad_address");
  let to: `0x${string}`;
  if (targetAddr.toLowerCase() === usdc && paramAddr.toLowerCase() !== usdc) to = paramAddr;
  else if (paramAddr.toLowerCase() === usdc && targetAddr.toLowerCase() !== usdc) to = targetAddr;
  else return unsupported("unsupported_token");

  const raw = params.get("uint256");
  if (raw === null) return withChain({ kind: "address", to, token: "USDC" });
  const base = parseUint(raw);
  if (base === null || base === 0n) return unsupported("not_wallet");
  return withChain({ kind: "address", to, token: "USDC", amount: fromBaseUnits(base) });
}

export function parseQr(text: string, cfg: ChainConfig): QrResult {
  if (typeof text !== "string") return unsupported("not_wallet");
  const t = text.trim();

  const c = CPAY.exec(t);
  if (c) {
    return { kind: "cpay", peerId: (c[1] ?? "").toLowerCase(), pub: (c[2] ?? "").toLowerCase(), qrSecret: (c[3] ?? "").toLowerCase() };
  }
  const o = CPAY_OFFLINE.exec(t);
  if (o) {
    const meta = parseMetaAddress((o[1] ?? "").toLowerCase());
    return meta ? { kind: "offline", metaAddress: meta.metaAddressURI } : unsupported("not_wallet");
  }
  if (/^cpay:/i.test(t)) return unsupported("not_wallet");

  if (/^ethereum:/i.test(t)) return parseEthereumUri("ethereum:" + t.slice(9), cfg);

  if (/^0x[0-9a-fA-F]*$/.test(t)) {
    const to = checkAddress(t);
    return to ? { kind: "address", to } : unsupported("bad_address");
  }
  return unsupported("not_wallet");
}

/**
 * The offline CPay QR for a meta-address (`st:eth:0x<132 hex>`): `CPAY:2:<132 HEX>`, upper-case so the whole code
 * is QR alphanumeric mode (139 chars, version 6 at ECC M). A stable identifier: show it only when the user opted in.
 */
export function offlineQrText(metaAddressURI: string): string {
  const m = /^st:eth:0x([0-9a-f]{132})$/i.exec(metaAddressURI);
  if (!m || !parseMetaAddress((m[1] ?? "").toLowerCase())) throw new Error("wallet: bad stealth meta-address");
  return `cpay:2:${m[1]}`.toUpperCase();
}

/**
 * The public "pay me" QR for an address: standard EIP-681 USDC transfer on cfg's chain,
 * optionally with an amount. parseQr() reads it back.
 */
export function addressQr(cfg: ChainConfig, to: `0x${string}`, amount?: string): string {
  const addr = checkAddress(to);
  if (!addr) throw new Error("wallet: bad address");
  let uri = `ethereum:${getAddress(cfg.usdc)}@${cfg.chainId}/transfer?address=${addr}`;
  if (amount !== undefined) {
    const base = toBaseUnits(amount);
    if (base === null) throw new Error("wallet: invalid amount");
    uri += `&uint256=${base}`;
  }
  return uri;
}
