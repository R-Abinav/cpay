import { beforeAll, describe, expect, it } from "vitest";
import { base64ToBytes, bindingDigest, bytesToBase64, bytesToHex, type BindingFields } from "@cpay/protocol";
import {
  commitmentSignal,
  currentEpoch,
  holderCommit,
  initCredential,
  issueBlind,
  issuerKeygen,
  issuerPublicKey,
  prove,
  unblind,
  verifyCard,
  verifyProof,
  type Card,
  type IssuerKeyPair,
} from "../src/index.js";

const fields: BindingFields = {
  sessionNonce: "ab".repeat(32),
  destination: "0x00000000000000000000000000000000000000Aa",
  chainId: 11155111,
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  amount: "2000000",
};

let issuer: IssuerKeyPair;
let card: Card;
let requestB64: string;
let s: Uint8Array;
let blinding: Uint8Array;

beforeAll(async () => {
  await initCredential();
  issuer = await issuerKeygen();
  const hc = await holderCommit();
  requestB64 = hc.commitment;
  s = base64ToBytes(hc.secret.s);
  blinding = base64ToBytes(hc.secret.blinding);
  const sig = await issueBlind(issuer.secretKey, hc.commitment, { tier: "orb", epoch: "2026-11" });
  card = await unblind(sig, hc.secret, issuer.publicKey);
}, 60_000);

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  return bytesToHex(hay).includes(bytesToHex(needle));
}

describe("blind issuance", () => {
  it("issues a card that verifies", async () => {
    expect(await verifyCard(card, issuer.publicKey)).toBe(true);
    expect(issuerPublicKey(issuer.secretKey)).toBe(issuer.publicKey);
  });

  it("the issuer never receives s or the blinding", () => {
    // Everything the issuer gets is the request payload. Neither raw secret appears in it
    // (in raw bytes, base64 or hex), and s is not one of its fields.
    const payload = base64ToBytes(requestB64);
    const text = new TextDecoder().decode(payload);
    const obj = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(obj).sort()).toEqual(["c", "pok", "v"]);
    for (const secret of [s, blinding]) {
      expect(text).not.toContain(bytesToBase64(secret));
      expect(text).not.toContain(bytesToHex(secret));
      expect(contains(base64ToBytes(obj.c!), secret)).toBe(false);
      expect(contains(base64ToBytes(obj.pok!), secret)).toBe(false);
    }
  });

  it("two commitments to fresh secrets differ, and commitmentSignal is stable hex", async () => {
    const other = await holderCommit();
    expect(other.commitment).not.toBe(requestB64);
    expect(commitmentSignal(requestB64)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commitmentSignal(requestB64)).toBe(commitmentSignal(requestB64));
  });

  it("rejects a request whose proof of knowledge doesn't match the commitment", async () => {
    const a = JSON.parse(new TextDecoder().decode(base64ToBytes(requestB64))) as Record<string, unknown>;
    const b = JSON.parse(new TextDecoder().decode(base64ToBytes((await holderCommit()).commitment))) as Record<
      string,
      unknown
    >;
    const forged = bytesToBase64(new TextEncoder().encode(JSON.stringify({ v: 1, c: a.c, pok: b.pok })));
    await expect(issueBlind(issuer.secretKey, forged, { tier: "orb", epoch: "2026-11" })).rejects.toThrow();
  });

  it("a card fails against a different issuer key, or with tampered attributes", async () => {
    const other = await issuerKeygen();
    expect(await verifyCard(card, other.publicKey)).toBe(false);
    expect(await verifyCard({ ...card, epoch: "2026-12" }, issuer.publicKey)).toBe(false);
    expect(await verifyCard({ ...card, tier: "selfie" }, issuer.publicKey)).toBe(false);
  });

  it("unblind throws on a wrong secret", async () => {
    const hc = await holderCommit();
    const sig = await issueBlind(issuer.secretKey, hc.commitment, { tier: "orb", epoch: "2026-11" });
    const wrong = (await holderCommit()).secret;
    await expect(unblind(sig, wrong, issuer.publicKey)).rejects.toThrow();
  });

  it("validates tier and epoch", async () => {
    const hc = await holderCommit();
    await expect(issueBlind(issuer.secretKey, hc.commitment, { tier: "orb", epoch: "2026-13" })).rejects.toThrow();
    expect(currentEpoch(new Date("2026-11-05T12:00:00Z"))).toBe("2026-11");
  });
});

describe("presentation bound to bindingDigest", () => {
  it("a valid proof verifies and reveals tier + epoch", async () => {
    const d = bindingDigest(fields);
    const proof = await prove(card, issuer.publicKey, d);
    await expect(verifyProof(proof, issuer.publicKey, d)).resolves.toEqual({ tier: "orb", epoch: "2026-11" });
  });

  it("a proof fails under a different digest (any field changed)", async () => {
    const proof = await prove(card, issuer.publicKey, bindingDigest(fields));
    const variants: BindingFields[] = [
      { ...fields, sessionNonce: "cd".repeat(32) },
      { ...fields, destination: "0x00000000000000000000000000000000000000Bb" },
      { ...fields, chainId: 1 },
      { ...fields, token: "0x0000000000000000000000000000000000000001" },
      { ...fields, amount: "20000000" },
    ];
    for (const v of variants) {
      await expect(verifyProof(proof, issuer.publicKey, bindingDigest(v))).rejects.toThrow();
    }
  });

  it("two proofs from the same card are different bytes, both valid", async () => {
    const d = bindingDigest(fields);
    const p1 = await prove(card, issuer.publicKey, d);
    const p2 = await prove(card, issuer.publicKey, d);
    expect(p1).not.toBe(p2);
    await verifyProof(p1, issuer.publicKey, d);
    await verifyProof(p2, issuer.publicKey, d);
  });

  it("the proof does not contain s or the blinding", async () => {
    const proof = await prove(card, issuer.publicKey, bindingDigest(fields));
    const text = new TextDecoder().decode(base64ToBytes(proof));
    const inner = base64ToBytes((JSON.parse(text) as { proof: string }).proof);
    for (const secret of [s, blinding]) {
      expect(text).not.toContain(bytesToBase64(secret));
      expect(contains(inner, secret)).toBe(false);
    }
  });

  it("rejects a proof whose revealed attributes were edited, or a wrong issuer key", async () => {
    const d = bindingDigest(fields);
    const proof = await prove(card, issuer.publicKey, d);
    const o = JSON.parse(new TextDecoder().decode(base64ToBytes(proof))) as Record<string, unknown>;
    const edited = bytesToBase64(new TextEncoder().encode(JSON.stringify({ ...o, epoch: "2027-01" })));
    await expect(verifyProof(edited, issuer.publicKey, d)).rejects.toThrow();
    const other = await issuerKeygen();
    await expect(verifyProof(proof, other.publicKey, d)).rejects.toThrow();
  });
});
