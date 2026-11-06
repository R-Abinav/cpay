import { describe, expect, it } from "vitest";
import {
  buildClaim2,
  buildFaceProbe,
  buildMatch,
  buildQuote,
  ClientMessage,
  cpayQrText,
  faceMatches,
  newQrSecret,
  qrSecretEquals,
  QrSecretBook,
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

const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEST = "0x000000000000000000000000000000000000dEaD";
const QS = "0123456789abcdef".repeat(2);

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
    const { round, message } = buildQuote({ peer: peerOf(r!), chainId: 84532, token: TOKEN, amount: 2_000_000n, matchSecret: "ab".repeat(32) });
    const inc = openIncoming(r!.secretKey, deliver(message, 0));
    expect(inc.kind).toBe("quote");
    if (inc.kind !== "quote") return;
    expect(inc.body).toMatchObject({ chainId: 84532, token: TOKEN, amount: "2000000", matchSecret: "ab".repeat(32) });
    const claim = buildClaim2(r!.secretKey, deliver(message, 0), { v: 2, sessionNonce: inc.body.sessionNonce, destination: DEST, credentialProof: "proof" });
    const opened = openClaim2(round, toPayer(claim));
    expect(opened).toMatchObject({ destination: DEST, sessionNonce: round.sessionNonce });
  });

  it("a claim with the wrong nonce or from another key is rejected", () => {
    const [r] = phones(1);
    const { round, message } = buildQuote({ peer: peerOf(r!), chainId: 84532, token: TOKEN, amount: "1", qrSecret: QS });
    const bad = buildClaim2(r!.secretKey, deliver(message, 0), { v: 2, sessionNonce: "00".repeat(32), destination: DEST, credentialProof: "p" });
    expect(openClaim2(round, toPayer(bad))).toBeNull();
    const imp = generateKeyPair();
    const forged = buildClaim2(imp.secretKey, deliver(message, 0), { v: 2, sessionNonce: round.sessionNonce, destination: DEST, credentialProof: "p" });
    expect(openClaim2(round, toPayer(forged))).toBeNull();
  });

  it("a face probe can't be opened as a quote and vice versa (separate contexts)", () => {
    const [r] = phones(1);
    const f = buildFaceProbe([peerOf(r!)], me);
    const q = buildQuote({ peer: peerOf(r!), chainId: 84532, token: TOKEN, amount: "1", qrSecret: QS });
    expect(openIncoming(r!.secretKey, deliver(f.message, 0)).kind).toBe("face");
    expect(openIncoming(r!.secretKey, deliver(q.message, 0)).kind).toBe("quote");
    expect(openIncoming(generateKeyPair().secretKey, deliver(q.message, 0)).kind).toBe("unknown");
  });

  it("recipient answers a quote only for a recent match of its own, or the secret of the QR on screen", () => {
    const n = "cd".repeat(32);
    const q = { v: 2 as const, sessionNonce: "ef".repeat(32), matchSecret: n, chainId: 84532, token: TOKEN, amount: "1" };
    const now = 1_000_000;
    const base = { recentMatches: new Map<string, number>(), showingCpayQr: true, qrSecret: QS, now };
    expect(shouldAnswerQuote(q, { ...base, recentMatches: new Map([[n, now - 1000]]), showingCpayQr: false })).toBe(true);
    expect(shouldAnswerQuote(q, { ...base, recentMatches: new Map([[n, now - PAY2_LIMITS.matchMemoryMs - 1]]) })).toBe(false);
    expect(shouldAnswerQuote(q, base)).toBe(false);
    const { matchSecret: _, ...rest } = q;
    const viaQr = { ...rest, qrSecret: QS };
    expect(shouldAnswerQuote(viaQr, base)).toBe(true);
    expect(shouldAnswerQuote(viaQr, { ...base, showingCpayQr: false })).toBe(false);
    expect(shouldAnswerQuote(viaQr, { ...base, qrSecret: null })).toBe(false);
    expect(shouldAnswerQuote({ ...viaQr, qrSecret: "f".repeat(32) }, base)).toBe(false);
    // knowing peerId + pub is not enough: a quote with no secret at all is never answered
    expect(shouldAnswerQuote(rest as never, base)).toBe(false);
  });

  it("a quote must carry exactly one of matchSecret / qrSecret", () => {
    const [r] = phones(1);
    const peer = peerOf(r!);
    expect(() => buildQuote({ peer, chainId: 84532, token: TOKEN, amount: "1" })).toThrow();
    expect(() => buildQuote({ peer, chainId: 84532, token: TOKEN, amount: "1", qrSecret: QS, matchSecret: "ab".repeat(32) })).toThrow();
    expect(() => buildQuote({ peer, chainId: 84532, token: TOKEN, amount: "1", qrSecret: "not-hex" })).toThrow();
    const { message } = buildQuote({ peer, chainId: 84532, token: TOKEN, amount: "1", qrSecret: QS });
    const inc = openIncoming(r!.secretKey, deliver(message, 0));
    expect(inc.kind === "quote" && inc.body.qrSecret).toBe(QS);
  });
});

describe("CPay QR secret", () => {
  it("newQrSecret is 16 random bytes of hex; equality is exact", () => {
    const a = newQrSecret();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newQrSecret()).not.toBe(a);
    expect(qrSecretEquals(a, a)).toBe(true);
    expect(qrSecretEquals(a, newQrSecret())).toBe(false);
    expect(qrSecretEquals(a, a.toUpperCase())).toBe(false);
    expect(qrSecretEquals("", "")).toBe(false);
  });

  it("cpayQrText is upper-case alphanumeric (QR alphanumeric mode) and validates the secret", () => {
    const t = cpayQrText("123e4567-e89b-42d3-a456-426614174000", "ab".repeat(32), QS);
    expect(t).toMatch(/^[0-9A-Z.:-]+$/);
    expect(t.length).toBe(141);
    expect(() => cpayQrText("x", "ab".repeat(32), "short")).toThrow();
  });

  it("QrSecretBook: <= 1 per interval, <= N per secret, rotate resets the per-secret count", () => {
    const b = new QrSecretBook();
    expect(b.current()).toBeNull();
    const s1 = b.rotate();
    expect(b.current()).toBe(s1);
    let t = 0;
    expect(b.admit(t)).toBe("ok");
    expect(b.admit(t + PAY2_LIMITS.qrQuoteMinIntervalMs - 1)).toBe("too_soon");
    for (let i = 1; i < PAY2_LIMITS.qrQuotesPerSecret; i++) expect(b.admit((t += PAY2_LIMITS.qrQuoteMinIntervalMs))).toBe("ok");
    expect(b.admit((t += PAY2_LIMITS.qrQuoteMinIntervalMs))).toBe("exhausted");
    const s2 = b.rotate();
    expect(s2).not.toBe(s1);
    expect(b.admit((t += PAY2_LIMITS.qrQuoteMinIntervalMs))).toBe("ok");
    b.clear();
    expect(b.current()).toBeNull();
  });
});
