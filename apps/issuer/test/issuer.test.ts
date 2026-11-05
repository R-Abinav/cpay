// Issuer tests. The World verify API is replaced by a local HTTP server INSIDE THESE TESTS ONLY;
// production code always calls https://developer.world.org.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import {
  commitmentSignal,
  holderCommit,
  initCredential,
  issuerKeygen,
  prove,
  unblind,
  verifyProof,
  type BlindSignature,
  type IssuerKeyPair,
} from "@cpay/credential";
import { bindingDigest } from "@cpay/protocol";
import { createIssuerApp, type IssuerOptions } from "../src/app.js";
import { normaliseNullifier, openNullifierStore } from "../src/db.js";
import { loadEnv } from "../src/config.js";

const RP_ID = "rp_0123456789abcdef";
const ACTION = "cpay-recipient-v1";

// ---- fake World verify server (tests only) ----
interface Seen {
  path: string;
  body: Record<string, unknown>;
}
let fake: Server;
let fakeBase: string;
let seen: Seen[] = [];
let reply: (body: Record<string, unknown>) => { status: number; json: unknown } = () => ({ status: 500, json: {} });

beforeAll(async () => {
  await initCredential();
  fake = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(data) as Record<string, unknown>;
      seen.push({ path: req.url ?? "", body });
      const r = reply(body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => fake.close(() => ok())));

let issuer: IssuerKeyPair;
let logs: string[];
function makeApp(over: Partial<IssuerOptions> = {}) {
  logs = [];
  return createIssuerApp({
    store: openNullifierStore(":memory:"),
    rpId: RP_ID,
    rpSigningKey: randomBytes(32).toString("hex"),
    bbsSecretKey: issuer.secretKey,
    environment: "staging",
    action: ACTION,
    allowedOrigins: ["http://localhost:3000"],
    verifyBase: fakeBase,
    log: (l) => logs.push(l),
    now: () => new Date("2026-11-06T10:00:00Z"),
    ...over,
  });
}

/** An IDKit 4.0 result shaped like the docs/types, for a signal. The proof itself is opaque to us. */
function idkitResult(signal: string, nullifier = "0x" + randomBytes(31).toString("hex")) {
  return {
    protocol_version: "4.0",
    nonce: "0x01",
    action: ACTION,
    environment: "staging",
    responses: [
      {
        identifier: "proof_of_human",
        issuer_schema_id: 1,
        signal_hash: hashSignal(signal),
        proof: ["1", "2", "3", "4", "5"],
        nullifier: BigInt(nullifier).toString(10),
        expires_at_min: 0,
      },
    ],
  };
}

const ok = (body: Record<string, unknown>) => ({
  status: 200,
  json: { success: true, environment: body.environment, action: ACTION, results: [{ identifier: "proof_of_human", success: true }] },
});

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  issuer = await issuerKeygen();
});
beforeEach(() => {
  seen = [];
  reply = ok;
});

describe("GET /health, /issuer-key", () => {
  it("serves health and the BBS public key", async () => {
    const app = makeApp();
    expect(await (await app.request("/health")).json()).toEqual({ ok: true, environment: "staging" });
    expect(await (await app.request("/issuer-key")).json()).toEqual({ publicKey: issuer.publicKey });
  });

  it("logs method + path + status only", async () => {
    const app = makeApp();
    await app.request("/health?secret=1", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(logs).toEqual(["[issuer] GET /health 200"]);
  });

  it("CORS allows only configured origins", async () => {
    const app = makeApp();
    const good = await app.request("/issuer-key", { headers: { origin: "http://localhost:3000" } });
    expect(good.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const bad = await app.request("/issuer-key", { headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("POST /rp-signature", () => {
  it("signs with a fresh nonce each time", async () => {
    const app = makeApp();
    const a = (await (await post(app, "/rp-signature", { action: ACTION })).json()) as Record<string, unknown>;
    const b = (await (await post(app, "/rp-signature", {})).json()) as Record<string, unknown>;
    expect(a.rp_id).toBe(RP_ID);
    expect(typeof a.sig).toBe("string");
    expect(a.nonce).not.toBe(b.nonce);
    expect(Number(a.expires_at)).toBeGreaterThan(Number(a.created_at));
  });

  it("refuses other actions", async () => {
    const res = await post(makeApp(), "/rp-signature", { action: "something-else" });
    expect(res.status).toBe(400);
  });
});

describe("POST /enrol", () => {
  it("verifies with World, stores the nullifier, returns a blind signature the holder can use", async () => {
    const app = makeApp();
    const hc = await holderCommit();
    const result = idkitResult(commitmentSignal(hc.commitment));
    const res = await post(app, "/enrol", { idkitResult: result, commitment: hc.commitment });
    expect(res.status).toBe(200);
    const blind = (await res.json()) as BlindSignature;
    expect(blind).toMatchObject({ tier: "orb", epoch: "2026-11" });

    // World saw the IDKit result unchanged, at the v4 verify path for our rp_id.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe(`/api/v4/verify/${RP_ID}`);
    expect(seen[0]!.body).toEqual(result);

    // The holder can unblind and present.
    const card = await unblind(blind, hc.secret, issuer.publicKey);
    const d = bindingDigest({
      sessionNonce: "ab".repeat(32),
      destination: "0x00000000000000000000000000000000000000Aa",
      chainId: 11155111,
      token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      amount: "8000000",
    });
    await expect(verifyProof(await prove(card, issuer.publicKey, d), issuer.publicKey, d)).resolves.toEqual({
      tier: "orb",
      epoch: "2026-11",
    });
  });

  it("rejects the same human twice (same nullifier, even with a new commitment)", async () => {
    const app = makeApp();
    const nullifier = "0x" + randomBytes(31).toString("hex");
    const a = await holderCommit();
    const b = await holderCommit();
    expect((await post(app, "/enrol", { idkitResult: idkitResult(commitmentSignal(a.commitment), nullifier), commitment: a.commitment })).status).toBe(200);
    const again = await post(app, "/enrol", { idkitResult: idkitResult(commitmentSignal(b.commitment), nullifier), commitment: b.commitment });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already enrolled" });
  });

  it("rejects when World says no, and stores nothing", async () => {
    const app = makeApp();
    const hc = await holderCommit();
    const result = idkitResult(commitmentSignal(hc.commitment));
    reply = () => ({ status: 400, json: { success: false, code: "all_verifications_failed", detail: "x" } });
    const res = await post(app, "/enrol", { idkitResult: result, commitment: hc.commitment });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "World verification failed: all_verifications_failed" });
    // Not stored: the same nullifier succeeds once World accepts.
    reply = ok;
    expect((await post(app, "/enrol", { idkitResult: result, commitment: hc.commitment })).status).toBe(200);
  });

  it("rejects a verify response from the wrong environment", async () => {
    const hc = await holderCommit();
    reply = () => ({ status: 200, json: { success: true, environment: "production" } });
    const res = await post(makeApp(), "/enrol", { idkitResult: idkitResult(commitmentSignal(hc.commitment)), commitment: hc.commitment });
    expect(res.status).toBe(400);
  });

  it("rejects an IDKit result for the wrong environment without calling World", async () => {
    const hc = await holderCommit();
    const result = { ...idkitResult(commitmentSignal(hc.commitment)), environment: "production" };
    const res = await post(makeApp(), "/enrol", { idkitResult: result, commitment: hc.commitment });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("rejects a signal that isn't hash(commitment)", async () => {
    const hc = await holderCommit();
    const other = await holderCommit();
    const res = await post(makeApp(), "/enrol", { idkitResult: idkitResult(commitmentSignal(other.commitment)), commitment: hc.commitment });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "signal does not match commitment" });
    expect(seen).toHaveLength(0);
  });

  it("rejects non Proof-of-Human credentials and legacy 3.0 proofs", async () => {
    const hc = await holderCommit();
    const base = idkitResult(commitmentSignal(hc.commitment));
    const selfie = { ...base, responses: [{ ...base.responses[0]!, identifier: "selfie", issuer_schema_id: 11 }] };
    expect((await post(makeApp(), "/enrol", { idkitResult: selfie, commitment: hc.commitment })).status).toBe(400);
    const legacy = { ...base, protocol_version: "3.0" };
    expect((await post(makeApp(), "/enrol", { idkitResult: legacy, commitment: hc.commitment })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("rejects when World echoes a different nullifier", async () => {
    const hc = await holderCommit();
    reply = (b) => ({ status: 200, json: { success: true, environment: b.environment, nullifier: "0x1234" } });
    const res = await post(makeApp(), "/enrol", { idkitResult: idkitResult(commitmentSignal(hc.commitment)), commitment: hc.commitment });
    expect(res.status).toBe(400);
  });

  it("returns 502 when World is unreachable", async () => {
    const hc = await holderCommit();
    const res = await post(makeApp({ verifyBase: "http://127.0.0.1:1" }), "/enrol", {
      idkitResult: idkitResult(commitmentSignal(hc.commitment)),
      commitment: hc.commitment,
    });
    expect(res.status).toBe(502);
  });

  it("rejects a malformed commitment", async () => {
    const bogus = btoa(JSON.stringify({ v: 1, c: "AAAA", pok: "AAAA" }));
    const res = await post(makeApp(), "/enrol", { idkitResult: idkitResult(commitmentSignal(bogus)), commitment: bogus });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("nullifier normalisation + config", () => {
  it("hex and decimal spellings normalise to the same decimal", () => {
    expect(normaliseNullifier("0x10")).toBe("16");
    expect(normaliseNullifier("16")).toBe("16");
    expect(normaliseNullifier("0x" + "f".repeat(64))).toBe(((1n << 256n) - 1n).toString());
    expect(() => normaliseNullifier("0x1" + "0".repeat(64))).toThrow();
    expect(() => normaliseNullifier("nope")).toThrow();
  });

  it("loadEnv fails fast on missing secrets and bad environment", () => {
    const env = {
      WORLD_ENVIRONMENT: "staging",
      WORLD_RP_ID: RP_ID,
      WORLD_RP_SIGNING_KEY: "ab",
      ISSUER_BBS_SECRET_KEY: "cd",
      ISSUER_ALLOWED_ORIGINS: "http://localhost:3000, https://x.example",
    };
    expect(loadEnv(env).allowedOrigins).toEqual(["http://localhost:3000", "https://x.example"]);
    expect(() => loadEnv({ ...env, WORLD_RP_SIGNING_KEY: "" })).toThrow(/WORLD_RP_SIGNING_KEY/);
    expect(() => loadEnv({ ...env, WORLD_ENVIRONMENT: "dev" })).toThrow();
  });
});
