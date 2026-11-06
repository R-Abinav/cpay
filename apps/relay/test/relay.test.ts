// Wallet one-time destinations live in IndexedDB on the phone; fake-indexeddb stands in for it here.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MAX_PAYLOAD_BYTES,
  RelayMessage,
  buildClaim,
  buildClaim2,
  buildFaceProbe,
  buildMatch,
  buildProbe,
  buildQuote,
  buildTemplate,
  faceMatches,
  generateKeyPair,
  openClaim2,
  openIncoming,
  openProbe,
  probeMatches,
  resolveClaims,
  resolveMatches,
  shouldAnswerQuote,
  type ClaimDelivery,
  type ClientMessage,
  type ProbeDelivery,
} from "@cpay/protocol";
import {
  KEY_DERIVATION_MESSAGE,
  createOneTimeDestination,
  keysFromSignature,
  ownsDestination,
  type OneTimeDestination,
  type StealthKeys,
} from "@cpay/stealth";
import { currentEpoch, holderCommit, initCredential, issueBlind, issuerKeygen, unblind } from "@cpay/credential";
import { answerQuote, deriveStealthKeys, listOneTimeDestinations, verifyClaim2 } from "@cpay/wallet";
import { createRelay, type Relay } from "../src/relay.js";

const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const DIM = 128;

/** Test client: queues parsed relay messages so tests can await them in order. */
class Client {
  ws: WebSocket;
  /** set by recipient.ready (kept out of the queue so ordered tests stay simple) */
  peerId: string | null = null;
  queue: RelayMessage[] = [];
  waiters: ((m: RelayMessage) => void)[] = [];
  open: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.ws.on("message", (d) => {
      const m = RelayMessage.parse(JSON.parse(d.toString()));
      if (m.type === "recipient.ready") {
        this.peerId = m.peerId;
        return;
      }
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }
  send(m: ClientMessage | Record<string, unknown>) {
    this.ws.send(JSON.stringify(m));
  }
  next(timeoutMs = 2000): Promise<RelayMessage> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(wrapped), 1);
        rej(new Error("timeout"));
      }, timeoutMs);
      const wrapped = (m: RelayMessage) => {
        clearTimeout(t);
        res(m);
      };
      this.waiters.push(wrapped);
    });
  }
  /** resolves true if nothing arrives within ms */
  async silent(ms = 300): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }
  close() {
    this.ws.close();
  }
}

/** Deterministic pseudo-random unit-ish vectors so each "face" is distinct. */
function face(seed: number): number[] {
  let x = seed * 9973 + 17;
  return Array.from({ length: DIM }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  });
}
function noisy(v: number[], seed: number, eps = 0.05): number[] {
  const n = face(seed + 1000);
  return v.map((x, i) => x + eps * n[i]!);
}

async function stealthKeys(): Promise<StealthKeys> {
  return keysFromSignature(await privateKeyToAccount(generatePrivateKey()).signMessage({ message: KEY_DERIVATION_MESSAGE }));
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("relay", () => {
  let relay: Relay;
  let url: string;
  const clients: Client[] = [];
  const client = async () => {
    const c = new Client(url);
    clients.push(c);
    await c.open;
    return c;
  };

  beforeEach(async () => {
    relay = createRelay({ port: 0, host: "127.0.0.1", maxSessionsPerPayer: 2 });
    url = `ws://127.0.0.1:${await relay.ready}`;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await relay.close();
  });

  it("e2e with 3 recipients: only the matching one replies; the payer opens exactly one claim to its destination", async () => {
    const people = await Promise.all(
      [0, 1, 2].map(async (i) => ({
        kp: generateKeyPair(),
        template: buildTemplate([0, 1, 2, 3, 4].map((j) => noisy(face(i), i * 10 + j))),
        keys: await stealthKeys(),
        client: await client(),
        replied: false,
        destination: null as OneTimeDestination | null,
      })),
    );
    for (const p of people) p.client.send({ type: "recipient.hello", pub: p.kp.publicKey });
    await settle();
    expect(relay.stats().recipients).toBe(3);

    const payer = await client();
    payer.send({ type: "payer.hello" });
    const peersMsg = await payer.next();
    if (peersMsg.type !== "peers") throw new Error("expected peers");
    expect(peersMsg.peers).toHaveLength(3);

    // The payer "looks at" person 1.
    const LOOKED_AT = 1;
    const { session, message } = buildProbe({
      peers: peersMsg.peers,
      embedding: noisy(face(LOOKED_AT), 999),
      chainId: 11155111,
      token: TOKEN,
      amount: 2_000_000n,
    });
    payer.send(message);

    // Every recipient gets exactly one probe it can open; only the match answers.
    await Promise.all(
      people.map(async (p) => {
        const m = await p.client.next();
        if (m.type !== "probe") throw new Error("expected probe");
        const body = openProbe(p.kp.secretKey, m as ProbeDelivery);
        expect(body.sessionNonce).toBe(session.sessionNonce);
        if (!probeMatches(body, p.template)) return;
        const dest = createOneTimeDestination(p.keys);
        p.replied = true;
        p.destination = dest; // stored on the phone only
        p.client.send(buildClaim(p.kp.secretKey, m as ProbeDelivery, {
          v: 1,
          sessionNonce: body.sessionNonce,
          destination: dest.address,
          credentialProof: "test-fixture-proof",
        }));
      }),
    );
    expect(people.map((p) => p.replied)).toEqual([false, true, false]);

    const claims: ClaimDelivery[] = [];
    const first = await payer.next();
    if (first.type !== "claim") throw new Error("expected claim");
    claims.push(first);
    expect(await payer.silent()).toBe(true);

    const r = resolveClaims(session, claims);
    if (!r.ok) throw new Error(`expected exactly one claim, got ${r.reason}`);
    const winner = people[LOOKED_AT]!;
    expect(r.claim.peerId).toBe(peersMsg.peers.find((p) => p.pub === winner.kp.publicKey)!.peerId);
    expect(r.claim.body.destination).toBe(winner.destination!.address);

    // The destination belongs to the looked-at recipient's stealth keys and to nobody else's.
    const record = winner.destination!;
    expect(people.map((p) => ownsDestination(p.keys, record))).toEqual([false, true, false]);
  });

  it("tells a recipient its own peerId (for the CPay QR), matching what payers see", async () => {
    const a = generateKeyPair();
    const ra = await client();
    ra.send({ type: "recipient.hello", pub: a.publicKey });
    await settle();
    expect(ra.peerId).toMatch(/^[0-9a-f-]{36}$/);
    const payer = await client();
    payer.send({ type: "payer.hello" });
    const peers = await payer.next();
    if (peers.type !== "peers") throw new Error();
    expect(peers.peers.find((p) => p.pub === a.publicKey)?.peerId).toBe(ra.peerId);
  });

  it("the payer aborts when two phones claim (exactly-one rule)", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ra = await client();
    const rb = await client();
    ra.send({ type: "recipient.hello", pub: a.publicKey });
    rb.send({ type: "recipient.hello", pub: b.publicKey });
    await settle();
    const payer = await client();
    payer.send({ type: "payer.hello" });
    const peers = await payer.next();
    if (peers.type !== "peers") throw new Error();
    const { session, message } = buildProbe({ peers: peers.peers, embedding: [1, 0], chainId: 1, token: TOKEN, amount: "1" });
    payer.send(message);
    for (const [r, kp] of [[ra, a], [rb, b]] as const) {
      const m = (await r.next()) as ProbeDelivery;
      r.send(buildClaim(kp.secretKey, m, { v: 1, sessionNonce: session.sessionNonce, destination: "0x000000000000000000000000000000000000dEaD", credentialProof: "x" }));
    }
    const claims = [(await payer.next()) as ClaimDelivery, (await payer.next()) as ClaimDelivery];
    expect(resolveClaims(session, claims)).toMatchObject({ ok: false, reason: "multiple" });
  });

  it("each probed recipient may claim once; unprobed or unknown sessions are refused", async () => {
    const a = generateKeyPair();
    const ra = await client();
    const rc = await client();
    ra.send({ type: "recipient.hello", pub: a.publicKey });
    await settle();
    const payer = await client();
    payer.send({ type: "payer.hello" });
    const peers = (await payer.next()) as { type: "peers"; peers: { peerId: string; pub: string }[] };
    // rc joins after the payer took its peer list, so it is not probed.
    rc.send({ type: "recipient.hello", pub: generateKeyPair().publicKey });
    const { session, message } = buildProbe({ peers: peers.peers, embedding: [1, 0], chainId: 1, token: TOKEN, amount: "1" });
    payer.send(message);
    const m = (await ra.next()) as ProbeDelivery;
    const claim = buildClaim(a.secretKey, m, { v: 1, sessionNonce: session.sessionNonce, destination: "0x000000000000000000000000000000000000dEaD", credentialProof: "x" });
    ra.send(claim);
    expect((await payer.next()).type).toBe("claim");
    ra.send(claim);
    expect(await ra.next()).toEqual({ type: "error", message: "no such session" });
    rc.send(claim);
    expect(await rc.next()).toEqual({ type: "error", message: "no such session" });
    expect(await payer.silent()).toBe(true);
  });

  it("rejects malformed messages, wrong roles and oversize payloads", async () => {
    const c = await client();
    c.ws.send("not json");
    expect(await c.next()).toEqual({ type: "error", message: "bad message" });
    c.send({ type: "probe", sessionId: "nope" });
    expect(await c.next()).toEqual({ type: "error", message: "bad message" });
    c.send({ type: "recipient.hello", pub: "AB".repeat(32) });
    expect(await c.next()).toEqual({ type: "error", message: "bad message" });
    c.send({ type: "claim", sessionId: crypto.randomUUID(), box: { iv: "", ct: "" } });
    expect(await c.next()).toEqual({ type: "error", message: "only recipients claim" });

    const r = await client();
    r.send({ type: "recipient.hello", pub: generateKeyPair().publicKey });
    r.send({ type: "payer.hello" });
    expect((await r.next()).type).toBe("error");

    const big = await client();
    const closed = new Promise<number>((res) => big.ws.once("close", (code) => res(code)));
    big.ws.send("x".repeat(MAX_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009); // message too big
  });

  it("pay v2 over the unchanged relay: face round finds exactly one phone, quote round reaches only it", async () => {
    await initCredential();
    const issuer = await issuerKeygen();
    const hc = await holderCommit();
    const card = await unblind(await issueBlind(issuer.secretKey, hc.commitment, { tier: "orb", epoch: currentEpoch() }), hc.secret, issuer.publicKey);

    const people = await Promise.all(
      [0, 1, 2].map(async (i) => ({
        kp: generateKeyPair(),
        template: buildTemplate([0, 1, 2, 3, 4].map((j) => noisy(face(i), i * 10 + j))),
        keys: deriveStealthKeys(new Uint8Array(32).fill(i + 1)),
        client: await client(),
        recentMatches: new Map<string, number>(),
      })),
    );
    for (const p of people) p.client.send({ type: "recipient.hello", pub: p.kp.publicKey });
    await settle();

    const payer = await client();
    payer.send({ type: "payer.hello" });
    const peersMsg = await payer.next();
    if (peersMsg.type !== "peers") throw new Error("expected peers");

    // Round 1: face only. Every phone gets one probe; only the looked-at one answers.
    const LOOKED_AT = 2;
    const face1 = buildFaceProbe(peersMsg.peers, noisy(face(LOOKED_AT), 777));
    payer.send(face1.message);
    const answered = await Promise.all(
      people.map(async (p) => {
        const m = (await p.client.next()) as ProbeDelivery;
        const inc = openIncoming(p.kp.secretKey, m);
        if (inc.kind !== "face") throw new Error("expected a face probe");
        expect(Object.keys(inc.body)).not.toContain("amount");
        if (!faceMatches(inc.body, p.template)) return false;
        const reply = buildMatch(p.kp.secretKey, m, inc.body);
        p.recentMatches.set(reply.matchSecret, Date.now());
        p.client.send(reply.message);
        return true;
      }),
    );
    expect(answered).toEqual([false, false, true]);
    const matches = [(await payer.next()) as ClaimDelivery];
    expect(await payer.silent()).toBe(true);
    const res = resolveMatches(face1.round, matches);
    if (!res.ok) throw new Error(`expected one match, got ${res.reason}`);
    const winner = people[LOOKED_AT]!;
    expect(res.peer.pub).toBe(winner.kp.publicKey);

    // Round 2: quote to that one peer only; it answers with a fresh destination + bound proof.
    const q = buildQuote({ peer: res.peer, matchSecret: res.matchSecret, chainId: 84532, token: TOKEN, amount: 2_000_000n });
    expect(q.round.sessionId).not.toBe(face1.round.sessionId);
    payer.send(q.message);
    for (const p of people.filter((x) => x !== winner)) expect(await p.client.silent()).toBe(true);
    const m2 = (await winner.client.next()) as ProbeDelivery;
    const inc2 = openIncoming(winner.kp.secretKey, m2);
    if (inc2.kind !== "quote") throw new Error("expected a quote");
    expect(shouldAnswerQuote(inc2.body, { recentMatches: winner.recentMatches, showingCpayQr: false, now: Date.now() })).toBe(true);
    const body = await answerQuote({ quote: inc2.body, card, issuerPublicKey: issuer.publicKey, stealthKeys: winner.keys });
    winner.client.send(buildClaim2(winner.kp.secretKey, m2, body));

    const claim = openClaim2(q.round, (await payer.next()) as ClaimDelivery);
    if (!claim) throw new Error("claim did not open");
    const v = await verifyClaim2({ round: q.round, claim, issuerPublicKey: issuer.publicKey });
    expect(v).toMatchObject({ ok: true, destination: body.destination, tier: "orb" });
    const stored = (await listOneTimeDestinations()).find((d) => d.address === body.destination)!;
    expect(people.map((p) => ownsDestination(p.keys, stored))).toEqual([false, false, true]);
    // A round-1 match body can't be replayed as a round-2 claim (different session + seal context).
    expect(openClaim2(q.round, matches[0]!)).toBeNull();
  }, 60_000);

  it("caps open sessions per payer and forgets everything on close", async () => {
    const r = await client();
    r.send({ type: "recipient.hello", pub: generateKeyPair().publicKey });
    await settle();
    const payer = await client();
    payer.send({ type: "payer.hello" });
    const peers = (await payer.next()) as { type: "peers"; peers: { peerId: string; pub: string }[] };
    const probe = () => buildProbe({ peers: peers.peers, embedding: [1], chainId: 1, token: TOKEN, amount: "1" }).message;
    payer.send(probe());
    payer.send(probe());
    payer.send(probe());
    expect(await payer.next()).toEqual({ type: "error", message: "too many open sessions" });
    expect(relay.stats().sessions).toBe(2);
    payer.close();
    r.close();
    await settle();
    expect(relay.stats()).toEqual({ recipients: 0, sessions: 0 });
  });
});
