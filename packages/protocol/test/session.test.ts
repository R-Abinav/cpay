import { describe, expect, it } from "vitest";
import {
  buildClaim,
  buildProbe,
  ClaimRequest,
  ClientMessage,
  generateKeyPair,
  openClaim,
  openProbe,
  probeMatches,
  ProbeBodySchema,
  resolveClaims,
  seal,
  claimContext,
  type ClaimDelivery,
} from "../src/index.js";

const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const DEST = "0x000000000000000000000000000000000000dEaD";

function recipients(n: number) {
  return Array.from({ length: n }, (_, i) => ({ peerId: `p${i}`, ...generateKeyPair() }));
}

describe("payer session helpers", () => {
  it("builds a valid probe with one sealed item per peer and opens on the recipient side", () => {
    const rs = recipients(3);
    const { session, message } = buildProbe({
      peers: rs.map((r) => ({ peerId: r.peerId, pub: r.publicKey })),
      embedding: [0.1, 0.2, 0.3],
      chainId: 11155111,
      token: TOKEN,
      amount: 2_000_000n,
    });
    expect(ClientMessage.parse(message)).toEqual(message);
    expect(message.items).toHaveLength(3);
    for (const [i, r] of rs.entries()) {
      const body = openProbe(r.secretKey, { type: "probe", sessionId: session.sessionId, payerPub: session.payerPub, box: message.items[i]!.box });
      expect(ProbeBodySchema.parse(body).sessionNonce).toBe(session.sessionNonce);
      expect(body.amount).toBe("2000000");
      expect(probeMatches(body, [0.1, 0.2, 0.3])).toBe(true);
      expect(probeMatches(body, [0.3, -0.2, -0.1])).toBe(false);
      expect(probeMatches(body, [0.1, 0.2])).toBe(false);
    }
    // one recipient can't open another's item
    expect(() => openProbe(rs[0]!.secretKey, { type: "probe", sessionId: session.sessionId, payerPub: session.payerPub, box: message.items[1]!.box })).toThrow();
  });

  function setup() {
    const rs = recipients(3);
    const { session } = buildProbe({
      peers: rs.map((r) => ({ peerId: r.peerId, pub: r.publicKey })),
      embedding: [1, 0],
      chainId: 11155111,
      token: TOKEN,
      amount: "1",
    });
    const claimFrom = (i: number, nonce = session.sessionNonce): ClaimDelivery => {
      const req = buildClaim(rs[i]!.secretKey, session, { v: 1, sessionNonce: nonce, destination: DEST, credentialProof: "proof" });
      return { type: "claim", sessionId: req.sessionId, box: req.box };
    };
    return { rs, session, claimFrom };
  }

  it("trial-decrypts a claim and identifies the responding peer", () => {
    const { session, claimFrom } = setup();
    const c = openClaim(session, claimFrom(2));
    expect(c?.peerId).toBe("p2");
    expect(c?.body.destination).toBe(DEST);
    expect(ClaimRequest.safeParse({ ...claimFrom(2) }).success).toBe(true);
  });

  it("rejects a claim from an unprobed key, a wrong nonce or a different session", () => {
    const { session, claimFrom } = setup();
    const stranger = generateKeyPair();
    const box = seal(stranger.secretKey, session.payerPub, claimContext(session.sessionId), { v: 1, sessionNonce: session.sessionNonce, destination: DEST, credentialProof: "x" });
    expect(openClaim(session, { type: "claim", sessionId: session.sessionId, box })).toBeNull();
    expect(openClaim(session, claimFrom(0, "cd".repeat(32)))).toBeNull();
    expect(openClaim(session, { ...claimFrom(0), sessionId: crypto.randomUUID() })).toBeNull();
  });

  it("enforces the exactly-one rule", () => {
    const { session, claimFrom } = setup();
    expect(resolveClaims(session, [])).toEqual({ ok: false, reason: "none", count: 0 });
    const one = resolveClaims(session, [claimFrom(1)]);
    expect(one.ok && one.claim.peerId).toBe("p1");
    expect(resolveClaims(session, [claimFrom(0), claimFrom(1)])).toMatchObject({ ok: false, reason: "multiple", count: 2 });
    // invalid claims don't count toward "multiple"
    const r = resolveClaims(session, [claimFrom(1), claimFrom(0, "cd".repeat(32))]);
    expect(r.ok).toBe(true);
  });

  it("uses a fresh key, id and nonce per session", () => {
    const peers = [{ peerId: "p", pub: generateKeyPair().publicKey }];
    const a = buildProbe({ peers, embedding: [1], chainId: 1, token: TOKEN, amount: "1" }).session;
    const b = buildProbe({ peers, embedding: [1], chainId: 1, token: TOKEN, amount: "1" }).session;
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionNonce).not.toBe(b.sessionNonce);
    expect(a.payerPub).not.toBe(b.payerPub);
  });
});
