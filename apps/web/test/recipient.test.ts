import { describe, expect, it } from "vitest";
import {
  bindingDigestHex,
  buildProbe,
  buildTemplate,
  bytesToHex,
  generateKeyPair,
  resolveClaims,
  type ProbeDelivery,
} from "@cpay/protocol";
import { findProbeForCode, handleProbe, handleQrClaim, qrPayload, readProbe, shortCode, type RecipientDeps } from "../lib/recipient.js";

// Test fixtures only: deterministic fake embeddings, destinations and a fake "proof" (the digest hex).
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const DIM = 128;
function vec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  let x = seed;
  for (let i = 0; i < DIM; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = x / 2147483648 - 0.5;
  }
  return v;
}
const jitter = (v: Float32Array, k: number) => v.map((x, i) => x + 0.05 * Math.sin(i * k));

let destCounter = 0;
function recipient(seed: number) {
  const kp = generateKeyPair();
  const face = vec(seed);
  const deps: RecipientDeps = {
    secretKey: kp.secretKey,
    template: buildTemplate([1, 2, 3, 4, 5].map((k) => jitter(face, k))),
    threshold: 0.6,
    chainId: 11155111,
    tokens: [USDC],
    createDestination: () => {
      const n = (++destCounter).toString(16).padStart(40, "0");
      return { address: `0x${n}`, ephemeralPublicKey: "0x02", viewTag: "0x01" };
    },
    prove: async (digest) => bytesToHex(digest),
  };
  return { kp, face, deps };
}

function deliveries(msg: ReturnType<typeof buildProbe>["message"]): Map<string, ProbeDelivery> {
  return new Map(msg.items.map((it) => [it.peerId, { type: "probe", sessionId: msg.sessionId, payerPub: msg.payerPub, box: it.box }]));
}

describe("recipient probe handling", () => {
  const people = [recipient(11), recipient(22), recipient(33)];
  const peers = people.map((p, i) => ({ peerId: `p${i}`, pub: p.kp.publicKey }));

  it("only the person being looked at answers, with a proof bound to the payment", async () => {
    const { session, message } = buildProbe({ peers, embedding: jitter(people[1]!.face, 9), chainId: 11155111, token: USDC, amount: 2_000_000n });
    const d = deliveries(message);
    const outcomes = await Promise.all(people.map((p, i) => handleProbe(p.deps, d.get(`p${i}`)!)));
    expect(outcomes.map((o) => o.kind)).toEqual(["no_match", "claimed", "no_match"]);

    const claimMsgs = outcomes.flatMap((o) => (o.kind === "claimed" ? [{ type: "claim" as const, sessionId: o.claim.sessionId, box: o.claim.box }] : []));
    const r = resolveClaims(session, claimMsgs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.peerId).toBe("p1");
    const expected = bindingDigestHex({
      sessionNonce: session.sessionNonce,
      destination: r.claim.body.destination,
      chainId: session.chainId,
      token: session.token,
      amount: session.amount,
    });
    expect(r.claim.body.credentialProof).toBe(expected);
  });

  it("stays silent on another chain", async () => {
    const { message } = buildProbe({ peers, embedding: people[0]!.face, chainId: 1, token: USDC, amount: 1n });
    const o = await handleProbe(people[0]!.deps, deliveries(message).get("p0")!);
    expect(o.kind).toBe("wrong_chain");
  });

  it("can't read a probe sealed to someone else", async () => {
    const { message } = buildProbe({ peers, embedding: people[0]!.face, chainId: 11155111, token: USDC, amount: 1n });
    const o = await handleProbe(people[2]!.deps, deliveries(message).get("p0")!);
    expect(o.kind).toBe("unreadable");
  });

  it("QR fallback: a non-matching recipient can explicitly claim via the session code", async () => {
    const stranger = vec(99);
    const { session, message } = buildProbe({ peers, embedding: stranger, chainId: 11155111, token: USDC, amount: 3_000_000n });
    const d = deliveries(message);
    const outcomes = await Promise.all(people.map((p, i) => handleProbe(p.deps, d.get(`p${i}`)!)));
    expect(outcomes.every((o) => o.kind === "no_match")).toBe(true);

    const opened = readProbe(people[2]!.deps.secretKey, d.get("p2")!)!;
    expect(findProbeForCode([opened], qrPayload(session.sessionId))).toBe(opened);
    expect(findProbeForCode([opened], shortCode(session.sessionId).toLowerCase())).toBe(opened);
    expect(findProbeForCode([opened], "nope")).toBeNull();

    const { claim } = await handleQrClaim(people[2]!.deps, opened);
    const r = resolveClaims(session, [{ type: "claim", sessionId: claim.sessionId, box: claim.box }]);
    expect(r.ok && r.claim.peerId).toBe("p2");
  });
});
