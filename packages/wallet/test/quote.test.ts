// Pay protocol v2 round 2 end to end (no relay): buildQuote -> recipient answerQuote -> buildClaim2 ->
// payer openClaim2 -> verifyClaim2. Plus every rejection branch of verifyClaim2.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { holderCommit, initCredential, issueBlind, issuerKeygen, unblind, type Card, type IssuerKeyPair } from "@cpay/credential";
import {
  buildClaim2,
  buildQuote,
  generateKeyPair,
  newQrSecret,
  openClaim2,
  openIncoming,
  type Claim2Body,
  type ProbeDelivery,
  type QuoteSession,
} from "@cpay/protocol";
import { ownsDestination } from "@cpay/stealth";
import { answerQuote, deriveStealthKeys, listOneTimeDestinations, verifyClaim2 } from "../src/index.js";
import { _resetStorageForTests } from "../src/storage.js";

const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NOW = new Date("2026-11-06T12:00:00Z");
const stealthKeys = deriveStealthKeys(new Uint8Array(32).fill(3));

let issuer: IssuerKeyPair;
let card: Card;

beforeAll(async () => {
  await initCredential();
  issuer = await issuerKeygen();
  const hc = await holderCommit();
  card = await unblind(await issueBlind(issuer.secretKey, hc.commitment, { tier: "orb", epoch: "2026-11" }), hc.secret, issuer.publicKey);
}, 60_000);

beforeEach(async () => {
  await _resetStorageForTests();
  globalThis.indexedDB = new IDBFactory();
});

/** One full quote round between a payer and a recipient phone; returns the payer's view. */
async function round(amount = 2_000_000n): Promise<{ round: QuoteSession; claim: Claim2Body }> {
  const recipient = generateKeyPair();
  const peer = { peerId: crypto.randomUUID(), pub: recipient.publicKey };
  const { round, message } = buildQuote({ peer, chainId: 84532, token: USDC, amount, qrSecret: newQrSecret() });
  const item = message.items[0]!;
  const delivery: ProbeDelivery = { type: "probe", sessionId: message.sessionId, payerPub: message.payerPub, box: item.box };
  const incoming = openIncoming(recipient.secretKey, delivery);
  if (incoming.kind !== "quote") throw new Error("expected a quote");
  const body = await answerQuote({ quote: incoming.body, card, issuerPublicKey: issuer.publicKey, stealthKeys });
  const req = buildClaim2(recipient.secretKey, delivery, body);
  const claim = openClaim2(round, { type: "claim", sessionId: req.sessionId, box: req.box });
  if (!claim) throw new Error("claim did not open");
  return { round, claim };
}

describe("answerQuote + verifyClaim2", () => {
  it("verifies a genuine claim and returns the persisted one-time destination", async () => {
    const { round: r, claim } = await round();
    const res = await verifyClaim2({ round: r, claim, issuerPublicKey: issuer.publicKey, now: NOW });
    expect(res).toEqual({ ok: true, destination: getAddress(claim.destination), tier: "orb", epoch: "2026-11" });
    const stored = await listOneTimeDestinations();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.address).toBe(claim.destination);
    expect(ownsDestination(stealthKeys, stored[0]!)).toBe(true);
  }, 30_000);

  it("hands out a fresh destination for every quote", async () => {
    const a = await round();
    const b = await round();
    expect(a.claim.destination).not.toBe(b.claim.destination);
    expect(await listOneTimeDestinations()).toHaveLength(2);
  }, 30_000);

  it("rejects a swapped destination (binding)", async () => {
    const { round: r, claim } = await round();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(await verifyClaim2({ round: r, claim: { ...claim, destination: other }, issuerPublicKey: issuer.publicKey, now: NOW })).toEqual({
      ok: false,
      reason: "proof",
    });
  }, 30_000);

  it("recomputes from the payer's own round: a changed amount, token or chain fails", async () => {
    const { round: r, claim } = await round();
    for (const tampered of [
      { ...r, amount: "2000001" },
      { ...r, token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
      { ...r, chainId: 11155111 },
    ]) {
      expect(await verifyClaim2({ round: tampered, claim, issuerPublicKey: issuer.publicKey, now: NOW })).toEqual({ ok: false, reason: "proof" });
    }
  }, 30_000);

  it("rejects a claim for another round's nonce", async () => {
    const a = await round();
    const b = await round();
    expect(await verifyClaim2({ round: a.round, claim: b.claim, issuerPublicKey: issuer.publicKey, now: NOW })).toEqual({ ok: false, reason: "nonce" });
  }, 30_000);

  it("rejects a proof under another issuer key", async () => {
    const { round: r, claim } = await round();
    const other = await issuerKeygen();
    expect(await verifyClaim2({ round: r, claim, issuerPublicKey: other.publicKey, now: NOW })).toEqual({ ok: false, reason: "proof" });
  }, 30_000);

  it("rejects a destination with a bad checksum", async () => {
    const { round: r, claim } = await round();
    const bad = { ...claim, destination: "0x00000000000000000000000000000000000000Aa" };
    expect(await verifyClaim2({ round: r, claim: bad, issuerPublicKey: issuer.publicKey, now: NOW })).toEqual({ ok: false, reason: "destination" });
  }, 30_000);

  it("rejects garbage proofs and the zero address", async () => {
    const { round: r, claim } = await round();
    expect(await verifyClaim2({ round: r, claim: { ...claim, credentialProof: "AAAA" }, issuerPublicKey: issuer.publicKey, now: NOW })).toEqual({
      ok: false,
      reason: "proof",
    });
    const zero = { ...claim, destination: "0x0000000000000000000000000000000000000000" };
    expect(await verifyClaim2({ round: r, claim: zero, issuerPublicKey: issuer.publicKey, now: NOW })).toEqual({ ok: false, reason: "destination" });
  }, 30_000);

  it("rejects a card from another epoch", async () => {
    const { round: r, claim } = await round();
    const dec = new Date("2026-12-01T00:00:00Z");
    expect(await verifyClaim2({ round: r, claim, issuerPublicKey: issuer.publicKey, now: dec })).toEqual({ ok: false, reason: "epoch" });
  }, 30_000);

  it("answerQuote refuses a malformed quote", async () => {
    await expect(
      answerQuote({
        quote: { v: 2, sessionNonce: "zz", chainId: 84532, token: USDC, amount: "1" } as never,
        card,
        issuerPublicKey: issuer.publicKey,
        stealthKeys,
      }),
    ).rejects.toThrow();
    expect(await listOneTimeDestinations()).toHaveLength(0);
  });
});
