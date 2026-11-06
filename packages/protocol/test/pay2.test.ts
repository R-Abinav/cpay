import { describe, expect, it } from "vitest";
import {
  buildClaim2,
  buildFaceProbe,
  buildMatch,
  buildQuote,
  ClientMessage,
  faceMatches,
  generateKeyPair,
  openClaim2,
  openIncoming,
  openMatch,
  PAY2_LIMITS,
  resolveMatches,
  shouldAnswerQuote,
  type ClaimDelivery,
  type ProbeDelivery,
  type ProbeRequest,
} from "../src/index.js";

const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const DEST = "0x000000000000000000000000000000000000dEaD";

const phones = (n: number) => Array.from({ length: n }, (_, i) => ({ peerId: `p${i}`, ...generateKeyPair() }));
const peerOf = (r: { peerId: string; publicKey: string }) => ({ peerId: r.peerId, pub: r.publicKey });
const deliver = (m: ProbeRequest, i: number): ProbeDelivery => ({ type: "probe", sessionId: m.sessionId, payerPub: m.payerPub, box: m.items[i]!.box });
const toPayer = (c: { sessionId: string; box: ClaimDelivery["box"] }): ClaimDelivery => ({ type: "claim", sessionId: c.sessionId, box: c.box });

const me = [1, 0, 0, 0];
const other = [0, 1, 0, 0];

describe("pay v2: face round", () => {
  it("probe carries no amount, token or chain, and only the matching phone answers", () => {
    const rs = phones(3);
    const { round, message } = buildFaceProbe(rs.map(peerOf), me);
    expect(ClientMessage.parse(message)).toEqual(message);
    const answers: ClaimDelivery[] = [];
    for (const [i, r] of rs.entries()) {
      const inc = openIncoming(r.secretKey, deliver(message, i));
      expect(inc.kind).toBe("face");
      if (inc.kind !== "face") continue;
      expect(Object.keys(inc.body).sort()).toEqual(["embedding", "sessionNonce", "v"]);
      const template = i === 1 ? me : other;
      if (faceMatches(inc.body, template)) answers.push(toPayer(buildMatch(r.secretKey, deliver(message, i), inc.body).message));
    }
    const res = resolveMatches(round, answers);
    expect(res).toMatchObject({ ok: true, peer: peerOf(rs[1]!) });
    // The secret is fresh from the matching phone, never the nonce every probed phone saw.
    if (res.ok) expect(res.matchSecret).not.toBe(round.sessionNonce);
  });

  it("zero or two matches abort; a duplicate from one phone counts once", () => {
    const rs = phones(2);
    const { round, message } = buildFaceProbe(rs.map(peerOf), me);
    expect(resolveMatches(round, [])).toMatchObject({ ok: false, reason: "none" });
    const ans = rs.map((r, i) => {
      const inc = openIncoming(r.secretKey, deliver(message, i));
      if (inc.kind !== "face") throw new Error("x");
      return toPayer(buildMatch(r.secretKey, deliver(message, i), inc.body).message);
    });
    expect(resolveMatches(round, ans)).toMatchObject({ ok: false, reason: "multiple", count: 2 });
    expect(resolveMatches(round, [ans[0]!, ans[0]!])).toMatchObject({ ok: true });
  });

  it("a match for another session or from an unprobed key is ignored", () => {
    const rs = phones(1);
    const a = buildFaceProbe(rs.map(peerOf), me);
    const b = buildFaceProbe(rs.map(peerOf), me);
    const inc = openIncoming(rs[0]!.secretKey, deliver(a.message, 0));
    if (inc.kind !== "face") throw new Error("x");
    const ans = toPayer(buildMatch(rs[0]!.secretKey, deliver(a.message, 0), inc.body).message);
    expect(openMatch(b.round, ans)).toBeNull();
    const stranger = generateKeyPair();
    expect(openMatch(a.round, toPayer(buildMatch(stranger.secretKey, deliver(a.message, 0), inc.body).message))).toBeNull();
  });
});

describe("pay v2: quote round", () => {
  it("quote -> claim round-trips and binds the payment fields", () => {
    const [r] = phones(1);
    const { round, message } = buildQuote({ peer: peerOf(r!), chainId: 11155111, token: TOKEN, amount: 2_000_000n, matchSecret: "ab".repeat(32) });
    const inc = openIncoming(r!.secretKey, deliver(message, 0));
    expect(inc.kind).toBe("quote");
    if (inc.kind !== "quote") return;
    expect(inc.body).toMatchObject({ chainId: 11155111, token: TOKEN, amount: "2000000", matchSecret: "ab".repeat(32) });
    const claim = buildClaim2(r!.secretKey, deliver(message, 0), { v: 2, sessionNonce: inc.body.sessionNonce, destination: DEST, credentialProof: "proof" });
    const opened = openClaim2(round, toPayer(claim));
    expect(opened).toMatchObject({ destination: DEST, sessionNonce: round.sessionNonce });
  });

  it("a claim with the wrong nonce or from another key is rejected", () => {
    const [r] = phones(1);
    const { round, message } = buildQuote({ peer: peerOf(r!), chainId: 11155111, token: TOKEN, amount: "1" });
    const bad = buildClaim2(r!.secretKey, deliver(message, 0), { v: 2, sessionNonce: "00".repeat(32), destination: DEST, credentialProof: "p" });
    expect(openClaim2(round, toPayer(bad))).toBeNull();
    const imp = generateKeyPair();
    const forged = buildClaim2(imp.secretKey, deliver(message, 0), { v: 2, sessionNonce: round.sessionNonce, destination: DEST, credentialProof: "p" });
    expect(openClaim2(round, toPayer(forged))).toBeNull();
  });

  it("a face probe can't be opened as a quote and vice versa (separate contexts)", () => {
    const [r] = phones(1);
    const f = buildFaceProbe([peerOf(r!)], me);
    const q = buildQuote({ peer: peerOf(r!), chainId: 11155111, token: TOKEN, amount: "1" });
    expect(openIncoming(r!.secretKey, deliver(f.message, 0)).kind).toBe("face");
    expect(openIncoming(r!.secretKey, deliver(q.message, 0)).kind).toBe("quote");
    expect(openIncoming(generateKeyPair().secretKey, deliver(q.message, 0)).kind).toBe("unknown");
  });

  it("recipient answers a quote only for a recent match of its own, or while showing its CPay QR", () => {
    const n = "cd".repeat(32);
    const q = { v: 2 as const, sessionNonce: "ef".repeat(32), matchSecret: n, chainId: 11155111, token: TOKEN, amount: "1" };
    const now = 1_000_000;
    expect(shouldAnswerQuote(q, { recentMatches: new Map([[n, now - 1000]]), showingCpayQr: false, now })).toBe(true);
    expect(shouldAnswerQuote(q, { recentMatches: new Map([[n, now - PAY2_LIMITS.matchMemoryMs - 1]]), showingCpayQr: true, now })).toBe(false);
    expect(shouldAnswerQuote(q, { recentMatches: new Map(), showingCpayQr: true, now })).toBe(false);
    const { matchSecret: _, ...plain } = q;
    expect(shouldAnswerQuote(plain, { recentMatches: new Map(), showingCpayQr: true, now })).toBe(true);
    expect(shouldAnswerQuote(plain, { recentMatches: new Map(), showingCpayQr: false, now })).toBe(false);
  });
});
