// Agent Pass tests against an in-process fake OIDC IdP (TESTS ONLY). It mimics World's discovery
// document shape (RS256, S256 PKCE, RFC 9207 iss in the callback) so the real oauth4webapi
// validation runs end to end. Production talks to AGENT_PASS_ISSUER over HTTPS.
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { approvalBindingCommit, newApprovalSalt, verifyApprovalToken, type ApprovalBinding, type JtiStore } from "@cpay/wallet";
import {
  approvalPublicKeyHex,
  cancelAgentPass,
  handleAgentPassCallback,
  resetAgentPassState,
  startAgentPass,
  subHashOf,
  takeAgentPassResult,
  type AgentPassConfig,
  type AgentPassRequest,
  type ApprovalResult,
} from "../src/index.js";

const ISS = "https://idp.test";
const ACR_ORB = "https://world.org/oidc/acr/orb";
const ACR_ORB_FACE = "https://world.org/oidc/acr/orb-face";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
const idpKey: KeyPair = await generateKeyPair("RS256");
const rogueKey: KeyPair = await generateKeyPair("RS256");
const jwk: JWK = { ...(await exportJWK(idpKey.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

interface Issued {
  challenge: string;
  nonce: string;
  redirectUri: string;
  claims: Record<string, unknown>;
  signWith: KeyPair;
}
const codes = new Map<string, Issued>();
let tokenCalls = 0;

const fakeIdp: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer: ISS,
      authorization_endpoint: `${ISS}/api/v1/authorize`,
      token_endpoint: `${ISS}/api/v1/token`,
      jwks_uri: `${ISS}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
      authorization_response_iss_parameter_supported: true,
      claims_parameter_supported: true,
    });
  }
  if (url.pathname === "/.well-known/jwks.json") return json({ keys: [jwk] });
  if (url.pathname === "/api/v1/token" && init?.method === "POST") {
    tokenCalls++;
    const auth = new Headers(init.headers).get("authorization") ?? "";
    // RFC 6749 2.3.1: id and secret are form-urlencoded before base64.
    const [id, secret] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
    if (id !== "client-1" || secret !== "secret-1") return json({ error: "invalid_client" }, 401);
    const body = new URLSearchParams(init.body as URLSearchParams);
    const issued = codes.get(body.get("code") ?? "");
    codes.delete(body.get("code") ?? "");
    if (!issued) return json({ error: "invalid_grant" }, 400);
    const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== issued.challenge || body.get("redirect_uri") !== issued.redirectUri) {
      return json({ error: "invalid_grant" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: issued.nonce, auth_time: now, acr: ACR_ORB, amr: ["world_id"], ...issued.claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISS)
      .setAudience("client-1")
      .setSubject("pairwise-sub")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(issued.signWith.privateKey);
    return json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
  }
  return json({ error: "not found" }, 404);
};


const APPROVAL_SK = randomBytes(32).toString("hex");
const APPROVAL_PK = approvalPublicKeyHex(APPROVAL_SK);

const config: AgentPassConfig = {
  issuer: ISS,
  clientId: "client-1",
  clientSecret: "secret-1",
  redirectUri: "http://localhost:3000/api/agent-pass/callback",
  acr: [ACR_ORB, ACR_ORB_FACE],
  approvalSecretKey: APPROVAL_SK,
  fetch: fakeIdp,
};

const TO = "0x00000000000000000000000000000000000000Aa";
// The payment and its salt stay on the phone; the server only ever sees COMMIT.
const binding: ApprovalBinding = { sessionId: "3f1c2b9e-0000-4000-8000-000000000001", amount: "8000000", token: USDC, to: TO };
const SALT = newApprovalSalt();
const COMMIT = approvalBindingCommit(binding, SALT);
const LINKED = subHashOf("pairwise-sub");
const approve = (bindingCommit = COMMIT, subHash = LINKED): AgentPassRequest => ({ mode: "approve", bindingCommit, subHash });

/** The phone's used-jti memory (IndexedDB on a real phone). */
function memJtis(): JtiStore {
  const seen = new Set<string>();
  return { has: async (j) => seen.has(j), add: async (j) => void seen.add(j) };
}

/** The human approves in World App: the IdP redirects back with a code (or an error). */
function approveInWorld(
  authorizeUrl: string,
  opts: { claims?: Record<string, unknown>; signWith?: KeyPair; iss?: string } = {},
): URL {
  const a = new URL(authorizeUrl);
  const code = randomBytes(16).toString("hex");
  codes.set(code, {
    challenge: a.searchParams.get("code_challenge")!,
    nonce: a.searchParams.get("nonce")!,
    redirectUri: a.searchParams.get("redirect_uri")!,
    claims: opts.claims ?? {},
    signWith: opts.signWith ?? idpKey,
  });
  const cb = new URL(config.redirectUri);
  cb.searchParams.set("code", code);
  cb.searchParams.set("state", a.searchParams.get("state")!);
  cb.searchParams.set("iss", opts.iss ?? ISS);
  return cb;
}

function denyInWorld(authorizeUrl: string, error = "access_denied"): URL {
  const a = new URL(authorizeUrl);
  const cb = new URL(config.redirectUri);
  cb.searchParams.set("error", error);
  cb.searchParams.set("error_description", "The user denied the request");
  cb.searchParams.set("state", a.searchParams.get("state")!);
  cb.searchParams.set("iss", ISS);
  return cb;
}

beforeEach(() => {
  resetAgentPassState();
  codes.clear();
  tokenCalls = 0;
});

describe("authorize request", () => {
  it("uses PKCE S256, state, nonce, max_age=0 and an essential acr claim; keeps the commitment server-side", async () => {
    const { url, state } = await startAgentPass(config, approve());
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${ISS}/api/v1/authorize`);
    const p = u.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("openid");
    expect(p.get("client_id")).toBe("client-1");
    expect(p.get("redirect_uri")).toBe(config.redirectUri);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toBe(state);
    expect(p.get("nonce")).toBeTruthy();
    expect(p.get("max_age")).toBe("0");
    expect(JSON.parse(p.get("claims")!)).toEqual({ id_token: { acr: { essential: true, values: [ACR_ORB, ACR_ORB_FACE] } } });
    expect(url).not.toContain("8000000");
    expect(url).not.toContain(binding.sessionId);
    expect(url.toLowerCase()).not.toContain(TO.toLowerCase());
    expect(takeAgentPassResult(state)).toEqual({ state: "pending" });
  });

  it("each attempt has fresh state, nonce and verifier", async () => {
    const a = new URL((await startAgentPass(config, approve())).url).searchParams;
    const b = new URL((await startAgentPass(config, approve())).url).searchParams;
    for (const k of ["state", "nonce", "code_challenge"]) expect(a.get(k)).not.toBe(b.get(k));
  });

  it("rejects malformed requests", async () => {
    await expect(startAgentPass(config, approve("ab"))).rejects.toThrow(/bindingCommit/);
    await expect(startAgentPass(config, approve(""))).rejects.toThrow(/bindingCommit/);
    await expect(startAgentPass(config, { mode: "approve", subHash: LINKED } as unknown as AgentPassRequest)).rejects.toThrow(/bindingCommit/);
    await expect(startAgentPass(config, approve(COMMIT, "not-a-hash"))).rejects.toThrow(/subHash/);
    await expect(startAgentPass({ ...config, approvalSecretKey: undefined }, approve())).rejects.toThrow(/APPROVAL_SECRET_KEY/);
    await expect(startAgentPass(config, { mode: "other" } as unknown as AgentPassRequest)).rejects.toThrow();
  });
});

describe("link mode", () => {
  it("returns sha256(sub) once and signs nothing", async () => {
    const { url, state } = await startAgentPass(config, { mode: "link" });
    const r = await handleAgentPassCallback(config, approveInWorld(url));
    expect(r).toEqual({ approved: true, reason: "linked", mode: "link", subHash: LINKED });
    expect(takeAgentPassResult(state)).toEqual({ state: "done", ...r });
    expect(takeAgentPassResult(state)).toEqual({ state: "none" });
  });
});

describe("approve path: one signed token, for exactly this payment", () => {
  it("issues an Ed25519 token the phone accepts once, for this binding only", async () => {
    const { url, state } = await startAgentPass(config, approve());
    const r = await handleAgentPassCallback(config, approveInWorld(url));
    expect(r).toMatchObject({ approved: true, mode: "approve", bindingCommit: COMMIT, subHash: LINKED });
    if (!r.approved || r.mode !== "approve") throw new Error("unreachable");
    expect(takeAgentPassResult(state)).toMatchObject({ state: "done", token: r.token });

    const jtis = memJtis();
    const check = (expected: ApprovalBinding, subHash = LINKED, salt = SALT) =>
      verifyApprovalToken(r.token, { expected, salt, subHash, publicKey: APPROVAL_PK, jtiStore: jtis });
    // An 8 USDC approval can't pay 80 USDC, another session, another token, another destination,
    // or be matched against another salt.
    expect(await check({ ...binding, amount: "80000000" })).toEqual({ ok: false, reason: "wrong_binding" });
    expect(await check({ ...binding, sessionId: "other" })).toEqual({ ok: false, reason: "wrong_binding" });
    expect(await check({ ...binding, token: "0x000000000000000000000000000000000000dEaD" })).toEqual({ ok: false, reason: "wrong_binding" });
    expect(await check({ ...binding, to: "0x00000000000000000000000000000000000000Bb" })).toEqual({ ok: false, reason: "wrong_binding" });
    expect(await check(binding, LINKED, newApprovalSalt())).toEqual({ ok: false, reason: "wrong_binding" });
    expect(await check(binding, subHashOf("someone-else"))).toEqual({ ok: false, reason: "wrong_sub" });
    expect((await check({ ...binding, to: TO.toLowerCase() })).ok).toBe(true);
    expect(await check(binding)).toEqual({ ok: false, reason: "reused" });
  });

  it("the server never holds the payment: not in memory, the result or the token", async () => {
    const { url, state } = await startAgentPass(config, approve());
    const g = globalThis as unknown as Record<symbol, { pending: Map<string, unknown> }>;
    const mem = JSON.stringify([...g[Symbol.for("cpay.world.agentPass.v2")]!.pending.values()]);
    const r = await handleAgentPassCallback(config, approveInWorld(url));
    if (!r.approved || r.mode !== "approve") throw new Error("expected approval");
    const tokenJson = Buffer.from(r.token.split(".")[0]!, "base64url").toString();
    expect(JSON.parse(tokenJson)).toMatchObject({ v: 2, bindingCommit: COMMIT, subHash: LINKED });
    for (const blob of [mem, JSON.stringify(r), JSON.stringify(takeAgentPassResult(state)), tokenJson]) {
      expect(blob).toContain(COMMIT);
      for (const v of Object.values(binding)) expect(blob.toLowerCase()).not.toContain(v.toLowerCase());
    }
  });

  it("the token expires after the TTL and fails under another key", async () => {
    const { url } = await startAgentPass(config, approve());
    const r = await handleAgentPassCallback(config, approveInWorld(url));
    if (!r.approved || r.mode !== "approve") throw new Error("expected approval");
    const later = Math.floor(Date.now() / 1000) + 301;
    expect(await verifyApprovalToken(r.token, { expected: binding, salt: SALT, subHash: LINKED, publicKey: APPROVAL_PK, now: later, jtiStore: memJtis() })).toEqual({
      ok: false,
      reason: "expired",
    });
    const otherPk = approvalPublicKeyHex(randomBytes(32).toString("hex"));
    expect(await verifyApprovalToken(r.token, { expected: binding, salt: SALT, subHash: LINKED, publicKey: otherPk, jtiStore: memJtis() })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("accepts any listed acr (orb-face)", async () => {
    const { url } = await startAgentPass(config, approve());
    const r = await handleAgentPassCallback(config, approveInWorld(url, { claims: { acr: ACR_ORB_FACE } }));
    expect(r.approved).toBe(true);
  });
});

describe("deny / cancel / expired / tampered: nothing is signed", () => {
  function expectNothing(r: ApprovalResult, reason?: RegExp) {
    expect(r.approved).toBe(false);
    expect(r).not.toHaveProperty("token");
    if (reason) expect(r.reason).toMatch(reason);
  }

  it("user denies in World App", async () => {
    const { url, state } = await startAgentPass(config, approve());
    const r = await handleAgentPassCallback(config, denyInWorld(url));
    expectNothing(r, /denied: access_denied/);
    expect(tokenCalls).toBe(0);
    expect(takeAgentPassResult(state)).toMatchObject({ state: "done", approved: false, reason: "denied: access_denied" });
  });

  it("a different World account than the one linked", async () => {
    const { url } = await startAgentPass(config, approve(COMMIT, subHashOf("the-real-owner")));
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url)), /different World account/);
  });

  it("IdP can't meet the essential acr", async () => {
    const { url } = await startAgentPass(config, approve());
    expectNothing(await handleAgentPassCallback(config, denyInWorld(url, "unmet_authentication_requirements")), /unmet_authentication_requirements/);
  });

  it("user stops on the phone before approving", async () => {
    const { url, state } = await startAgentPass(config, approve());
    expect(cancelAgentPass(state)).toBe(true);
    expect(takeAgentPassResult(state)).toEqual({ state: "none" });
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url)), /unknown or expired/);
  });

  it("attempt expired before the human came back", async () => {
    const { url } = await startAgentPass(config, approve());
    const later = { ...config, now: () => Date.now() + 301_000 };
    expectNothing(await handleAgentPassCallback(later, approveInWorld(url)), /unknown or expired|expired/);
  });

  it("a callback can't be replayed", async () => {
    const { url } = await startAgentPass(config, approve());
    const cb = approveInWorld(url);
    expect((await handleAgentPassCallback(config, cb)).approved).toBe(true);
    expectNothing(await handleAgentPassCallback(config, cb), /unknown or expired/);
  });

  it("unknown state", async () => {
    await startAgentPass(config, approve());
    const cb = new URL(config.redirectUri);
    cb.searchParams.set("code", "x");
    cb.searchParams.set("state", "forged");
    cb.searchParams.set("iss", ISS);
    expectNothing(await handleAgentPassCallback(config, cb), /unknown/);
  });

  it("wrong iss in the callback (mix-up)", async () => {
    const { url } = await startAgentPass(config, approve());
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { iss: "https://evil.test" })), /validation failed/);
  });

  it("wrong nonce in the ID token", async () => {
    const { url } = await startAgentPass(config, approve());
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { nonce: "other" } })), /validation failed/);
  });

  it("acr not in the accepted list", async () => {
    const { url } = await startAgentPass(config, approve());
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { acr: "https://world.org/oidc/acr/selfie" } })), /acr/);
  });

  it("missing acr", async () => {
    const { url } = await startAgentPass(config, approve());
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { acr: undefined } })), /acr/);
  });

  it("stale auth_time (older than maxAuthAgeSeconds)", async () => {
    const { url } = await startAgentPass(config, approve());
    const old = Math.floor(Date.now() / 1000) - 200;
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { auth_time: old } })), /validation failed|too old/);
  });

  it("auth_time from before this attempt (a reused login)", async () => {
    const { url } = await startAgentPass(config, approve());
    const before = Math.floor(Date.now() / 1000) - 60;
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { auth_time: before } })), /predates/);
  });

  it("ID token signed by a key not in the IdP's JWKS", async () => {
    const { url } = await startAgentPass(config, approve());
    expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { signWith: rogueKey })), /validation failed/);
  });
});
