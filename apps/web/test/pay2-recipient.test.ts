import { describe, expect, it } from "vitest";
import {
  PAY2_LIMITS,
  buildFaceProbe,
  buildQuote,
  generateKeyPair,
  openClaim2,
  resolveMatches,
  type Claim2Body,
  type ClaimDelivery,
  type ProbeDelivery,
  type ProbeRequest,
  type QuoteBody,
  QrSecretBook,
} from "@cpay/protocol";
import { handlePay2Probe, type Pay2RecipientDeps } from "../lib/pay2-recipient.js";

const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEST = "0x000000000000000000000000000000000000dEaD";
const CHAIN = 84532;
const me = [1, 0, 0, 0];
const other = [0, 1, 0, 0];

const deliver = (m: ProbeRequest, i = 0): ProbeDelivery => ({ type: "probe", sessionId: m.sessionId, payerPub: m.payerPub, box: m.items[i]!.box });
const toPayer = (c: { sessionId: string; box: ClaimDelivery["box"] }): ClaimDelivery => ({ type: "claim", sessionId: c.sessionId, box: c.box });

function phone(template: number[] | null, opts: { showing?: boolean; now?: number } = {}) {
  const kp = generateKeyPair();
  const answered: QuoteBody[] = [];
  const qrSecrets = new QrSecretBook();
  if (opts.showing) qrSecrets.rotate();
  let rotations = 0;
  let now = opts.now ?? 1_000;
  const deps: Pay2RecipientDeps = {
    secretKey: kp.secretKey,
    template,
    threshold: 0.6,
    chainId: CHAIN,
    token: TOKEN,
    showingCpayQr: () => opts.showing ?? false,
    qrSecrets,
    onQrRotated: () => rotations++,
    recentMatches: new Map(),
    now: () => now,
    // Test fixture standing in for packages/wallet answerQuote (real one proves with BBS).
    answer: async (q): Promise<Claim2Body> => {
      answered.push(q);
      return { v: 2, sessionNonce: q.sessionNonce, destination: DEST, credentialProof: "proof" };
    },
  };
  return { peer: { peerId: "p1", pub: kp.publicKey }, deps, answered, qrSecrets, rotations: () => rotations, advance: (ms: number) => (now += ms) };
}

/** Run round 1 against this phone and return the secret the payer would get from its sealed match. */
async function matchSecretOf(r: ReturnType<typeof phone>, face: ReturnType<typeof buildFaceProbe>): Promise<string> {
  const out = await handlePay2Probe(r.deps, deliver(face.message));
  if (out.kind !== "matched") throw new Error("expected a match");
  const res = resolveMatches(face.round, [toPayer(out.reply)]);
  if (!res.ok) throw new Error("expected one match");
  return res.matchSecret;
}

describe("recipient v2", () => {
  it("matching face -> sealed match; payer resolves exactly this peer", async () => {
    const r = phone(me);
    const { round, message } = buildFaceProbe([r.peer], me);
    const out = await handlePay2Probe(r.deps, deliver(message));
    expect(out.kind).toBe("matched");
    if (out.kind !== "matched") return;
    const res = resolveMatches(round, [toPayer(out.reply)]);
    expect(res).toMatchObject({ ok: true, peer: r.peer });
    if (!res.ok) return;
    expect(res.matchSecret).not.toBe(round.sessionNonce);
    expect(r.deps.recentMatches.has(res.matchSecret)).toBe(true);
    expect(r.deps.recentMatches.has(round.sessionNonce)).toBe(false);
  });

  it("other face -> silence; no template -> ignored", async () => {
    const r = phone(other);
    const { message } = buildFaceProbe([r.peer], me);
    expect((await handlePay2Probe(r.deps, deliver(message))).kind).toBe("no_match");
    expect(r.deps.recentMatches.size).toBe(0);
    const n = phone(null);
    const p = buildFaceProbe([n.peer], me);
    expect((await handlePay2Probe(n.deps, deliver(p.message))).kind).toBe("ignored");
  });

  it("quote for our recent match -> claim the payer can open; single use", async () => {
    const r = phone(me);
    const face = buildFaceProbe([r.peer], me);
    const secret = await matchSecretOf(r, face);
    const q = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: 2_000_000n, matchSecret: secret });
    const out = await handlePay2Probe(r.deps, deliver(q.message));
    expect(out.kind).toBe("claimed");
    if (out.kind !== "claimed") return;
    expect(openClaim2(q.round, toPayer(out.reply))?.destination).toBe(DEST);
    const again = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: 2_000_000n, matchSecret: secret });
    expect(await handlePay2Probe(r.deps, deliver(again.message))).toEqual({ kind: "quote_refused", why: "not_ours" });
    expect(r.answered).toHaveLength(1);
  });

  it("quote for an unknown or expired match is refused", async () => {
    const r = phone(me);
    const face = buildFaceProbe([r.peer], me);
    const secret = await matchSecretOf(r, face);
    r.advance(PAY2_LIMITS.matchMemoryMs + 1);
    const q = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: "1", matchSecret: secret });
    expect(await handlePay2Probe(r.deps, deliver(q.message))).toEqual({ kind: "quote_refused", why: "not_ours" });
    const q2 = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: "1", matchSecret: "f".repeat(64) });
    expect((await handlePay2Probe(r.deps, deliver(q2.message))).kind).toBe("quote_refused");
  });

  it("another probed phone replaying the round-1 nonce can't get a quote answered", async () => {
    const r = phone(me);
    const face = buildFaceProbe([r.peer], me);
    await matchSecretOf(r, face);
    // Every probed phone saw face.round.sessionNonce; it must not work as the quote secret.
    const replay = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: "1", matchSecret: face.round.sessionNonce });
    expect(await handlePay2Probe(r.deps, deliver(replay.message))).toEqual({ kind: "quote_refused", why: "not_ours" });
    expect(r.answered).toHaveLength(0);
  });

  it("CPay QR quote only while the QR is on screen and with its current secret", async () => {
    const hidden = phone(me, { showing: false });
    const q = buildQuote({ peer: hidden.peer, chainId: CHAIN, token: TOKEN, amount: "5", qrSecret: "ab".repeat(16) });
    expect((await handlePay2Probe(hidden.deps, deliver(q.message))).kind).toBe("quote_refused");
    const shown = phone(null, { showing: true });
    // peerId + pub alone (e.g. from the relay's peers list) with a guessed secret: refused, nothing proved
    const guess = buildQuote({ peer: shown.peer, chainId: CHAIN, token: TOKEN, amount: "5", qrSecret: "ab".repeat(16) });
    expect(await handlePay2Probe(shown.deps, deliver(guess.message))).toEqual({ kind: "quote_refused", why: "not_ours" });
    const secret = shown.qrSecrets.current()!;
    const q2 = buildQuote({ peer: shown.peer, chainId: CHAIN, token: TOKEN, amount: "5", qrSecret: secret });
    const out = await handlePay2Probe(shown.deps, deliver(q2.message));
    expect(out).toMatchObject({ kind: "claimed", via: "qr" });
    // one payment per shown QR: the secret rotated and the old one no longer works
    expect(shown.rotations()).toBe(1);
    expect(shown.qrSecrets.current()).not.toBe(secret);
    shown.advance(PAY2_LIMITS.qrQuoteMinIntervalMs);
    const replay = buildQuote({ peer: shown.peer, chainId: CHAIN, token: TOKEN, amount: "5", qrSecret: secret });
    expect(await handlePay2Probe(shown.deps, deliver(replay.message))).toEqual({ kind: "quote_refused", why: "not_ours" });
    expect(shown.answered).toHaveLength(1);
  });

  it("QR quotes are rate-limited: one per 5 s", async () => {
    const r = phone(null, { showing: true });
    const first = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: "5", qrSecret: r.qrSecrets.current()! });
    expect((await handlePay2Probe(r.deps, deliver(first.message))).kind).toBe("claimed");
    const fast = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: "5", qrSecret: r.qrSecrets.current()! });
    expect(await handlePay2Probe(r.deps, deliver(fast.message))).toEqual({ kind: "quote_refused", why: "rate_limited" });
    r.advance(PAY2_LIMITS.qrQuoteMinIntervalMs);
    expect((await handlePay2Probe(r.deps, deliver(fast.message))).kind).toBe("claimed");
    expect(r.answered).toHaveLength(2);
  });

  it("quote for another chain or token is refused", async () => {
    const r = phone(null, { showing: true });
    const q = buildQuote({ peer: r.peer, chainId: 1, token: TOKEN, amount: "5", qrSecret: r.qrSecrets.current()! });
    expect(await handlePay2Probe(r.deps, deliver(q.message))).toEqual({ kind: "quote_refused", why: "wrong_chain" });
  });

  it("a probe sealed to someone else is ignored", async () => {
    const r = phone(me);
    const stranger = { peerId: "x", pub: generateKeyPair().publicKey };
    const { message } = buildFaceProbe([stranger], me);
    expect((await handlePay2Probe(r.deps, deliver(message))).kind).toBe("ignored");
  });
});
