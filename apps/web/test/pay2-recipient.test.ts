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
  let now = opts.now ?? 1_000;
  const deps: Pay2RecipientDeps = {
    secretKey: kp.secretKey,
    template,
    threshold: 0.6,
    chainId: CHAIN,
    token: TOKEN,
    showingCpayQr: () => opts.showing ?? false,
    recentMatches: new Map(),
    now: () => now,
    // Test fixture standing in for packages/wallet answerQuote (real one proves with BBS).
    answer: async (q): Promise<Claim2Body> => {
      answered.push(q);
      return { v: 2, sessionNonce: q.sessionNonce, destination: DEST, credentialProof: "proof" };
    },
  };
  return { peer: { peerId: "p1", pub: kp.publicKey }, deps, answered, advance: (ms: number) => (now += ms) };
}

describe("recipient v2", () => {
  it("matching face -> sealed match; payer resolves exactly this peer", async () => {
    const r = phone(me);
    const { round, message } = buildFaceProbe([r.peer], me);
    const out = await handlePay2Probe(r.deps, deliver(message));
    expect(out.kind).toBe("matched");
    if (out.kind !== "matched") return;
    expect(resolveMatches(round, [toPayer(out.reply)])).toEqual({ ok: true, peer: r.peer, matchNonce: round.sessionNonce });
    expect(r.deps.recentMatches.has(round.sessionNonce)).toBe(true);
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
    await handlePay2Probe(r.deps, deliver(face.message));
    const q = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: 2_000_000n, matchNonce: face.round.sessionNonce });
    const out = await handlePay2Probe(r.deps, deliver(q.message));
    expect(out.kind).toBe("claimed");
    if (out.kind !== "claimed") return;
    expect(openClaim2(q.round, toPayer(out.reply))?.destination).toBe(DEST);
    const again = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: 2_000_000n, matchNonce: face.round.sessionNonce });
    expect(await handlePay2Probe(r.deps, deliver(again.message))).toEqual({ kind: "quote_refused", why: "not_ours" });
    expect(r.answered).toHaveLength(1);
  });

  it("quote for an unknown or expired match is refused", async () => {
    const r = phone(me);
    const face = buildFaceProbe([r.peer], me);
    await handlePay2Probe(r.deps, deliver(face.message));
    r.advance(PAY2_LIMITS.matchMemoryMs + 1);
    const q = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: "1", matchNonce: face.round.sessionNonce });
    expect(await handlePay2Probe(r.deps, deliver(q.message))).toEqual({ kind: "quote_refused", why: "not_ours" });
    const q2 = buildQuote({ peer: r.peer, chainId: CHAIN, token: TOKEN, amount: "1", matchNonce: "f".repeat(64) });
    expect((await handlePay2Probe(r.deps, deliver(q2.message))).kind).toBe("quote_refused");
  });

  it("CPay QR quote (no matchNonce) only while the QR is on screen", async () => {
    const hidden = phone(me, { showing: false });
    const q = buildQuote({ peer: hidden.peer, chainId: CHAIN, token: TOKEN, amount: "5" });
    expect((await handlePay2Probe(hidden.deps, deliver(q.message))).kind).toBe("quote_refused");
    const shown = phone(null, { showing: true });
    const q2 = buildQuote({ peer: shown.peer, chainId: CHAIN, token: TOKEN, amount: "5" });
    expect((await handlePay2Probe(shown.deps, deliver(q2.message))).kind).toBe("claimed");
  });

  it("quote for another chain or token is refused", async () => {
    const r = phone(null, { showing: true });
    const q = buildQuote({ peer: r.peer, chainId: 1, token: TOKEN, amount: "5" });
    expect(await handlePay2Probe(r.deps, deliver(q.message))).toEqual({ kind: "quote_refused", why: "wrong_chain" });
  });

  it("a probe sealed to someone else is ignored", async () => {
    const r = phone(me);
    const stranger = { peerId: "x", pub: generateKeyPair().publicKey };
    const { message } = buildFaceProbe([stranger], me);
    expect((await handlePay2Probe(r.deps, deliver(message))).kind).toBe("ignored");
  });
});
