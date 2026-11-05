// Agent Pass tests against an in-process fake OIDC IdP (TESTS ONLY). It mimics World's discovery
// document shape (RS256, S256 PKCE, RFC 9207 iss in the callback) so the real oauth4webapi
// validation runs end to end. Production talks to AGENT_PASS_ISSUER over HTTPS.
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  cancelAgentPass,
  consumeApproval,
  handleAgentPassCallback,
  resetAgentPassState,
  startAgentPass,
  type AgentPassConfig,
  type ApprovalBinding,
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

const config: AgentPassConfig = {
  issuer: ISS,
  clientId: "client-1",
  clientSecret: "secret-1",
  redirectUri: "http://localhost:3000/api/agent-pass/callback",
  acr: [ACR_ORB, ACR_ORB_FACE],
  fetch: fakeIdp,
};

const binding: ApprovalBinding = { sessionId: "sess-1", amount: "8000000", token: USDC };

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
  it("uses PKCE S256, state, nonce, max_age=0 and an essential acr claim; keeps the binding server-side", async () => {
    const { url, state } = await startAgentPass(config, binding);
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
    expect(url).not.toContain("sess-1");
  });

  it("each attempt has fresh state, nonce and verifier", async () => {
    const a = new URL((await startAgentPass(config, binding)).url).searchParams;
    const b = new URL((await startAgentPass(config, binding)).url).searchParams;
    for (const k of ["state", "nonce", "code_challenge"]) expect(a.get(k)).not.toBe(b.get(k));
  });

  it("rejects malformed bindings", async () => {
    await expect(startAgentPass(config, { ...binding, amount: "8.5" })).rejects.toThrow();
    await expect(startAgentPass(config, { ...binding, token: "usdc" })).rejects.toThrow();
  });
});

describe("approve path: the protected action runs once, for exactly this payment", () => {
  it("approves, and consumeApproval is true once for the exact binding", async () => {
    const { url } = await startAgentPass(config, binding);
    const r = await handleAgentPassCallback(config, approveInWorld(url));
    expect(r).toEqual({ approved: true, reason: "approved", binding: { ...binding, token: USDC.toLowerCase() } });
    // An 8 USDC approval can't pay 80 USDC, or another session.
    expect(consumeApproval({ ...binding, amount: "80000000" })).toBe(false);
    expect(consumeApproval({ ...binding, sessionId: "sess-2" })).toBe(false);
    expect(consumeApproval(binding)).toBe(true);
    expect(consumeApproval(binding)).toBe(false);
  });

  it("accepts any listed acr (orb-face)", async () => {
    const { url } = await startAgentPass(config, binding);
    const r = await handleAgentPassCallback(config, approveInWorld(url, { claims: { acr: ACR_ORB_FACE } }));
    expect(r.approved).toBe(true);
  });

  it("an approval expires after the TTL", async () => {
    const { url } = await startAgentPass(config, binding);
    expect((await handleAgentPassCallback(config, approveInWorld(url))).approved).toBe(true);
    expect(consumeApproval(binding, Date.now() + 301_000)).toBe(false);
  });
});

describe("deny / cancel / expired / tampered: nothing is approved", () => {
  async function expectNothing(r: { approved: boolean; reason: string }, reason?: RegExp) {
    expect(r.approved).toBe(false);
    if (reason) expect(r.reason).toMatch(reason);
    expect(consumeApproval(binding)).toBe(false);
  }

  it("user denies in World App", async () => {
    const { url } = await startAgentPass(config, binding);
    await expectNothing(await handleAgentPassCallback(config, denyInWorld(url)), /denied: access_denied/);
    expect(tokenCalls).toBe(0);
  });

  it("IdP can't meet the essential acr", async () => {
    const { url } = await startAgentPass(config, binding);
    await expectNothing(
      await handleAgentPassCallback(config, denyInWorld(url, "unmet_authentication_requirements")),
      /unmet_authentication_requirements/,
    );
  });

  it("user cancels on the glasses before approving", async () => {
    const { url, state } = await startAgentPass(config, binding);
    expect(cancelAgentPass(state)).toBe(true);
    await expectNothing(await handleAgentPassCallback(config, approveInWorld(url)), /unknown or expired/);
  });

  it("attempt expired before the human came back", async () => {
    const { url } = await startAgentPass(config, binding);
    const later = { ...config, now: () => Date.now() + 301_000 };
    await expectNothing(await handleAgentPassCallback(later, approveInWorld(url)), /unknown or expired|expired/);
  });

  it("a callback can't be replayed", async () => {
    const { url } = await startAgentPass(config, binding);
    const cb = approveInWorld(url);
    expect((await handleAgentPassCallback(config, cb)).approved).toBe(true);
    expect(consumeApproval(binding)).toBe(true);
    await expectNothing(await handleAgentPassCallback(config, cb), /unknown or expired/);
  });

  it("unknown state", async () => {
    await startAgentPass(config, binding);
    const cb = new URL(config.redirectUri);
    cb.searchParams.set("code", "x");
    cb.searchParams.set("state", "forged");
    cb.searchParams.set("iss", ISS);
    await expectNothing(await handleAgentPassCallback(config, cb), /unknown/);
  });

  it("wrong iss in the callback (mix-up)", async () => {
    const { url } = await startAgentPass(config, binding);
    await expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { iss: "https://evil.test" })), /validation failed/);
  });

  it("wrong nonce in the ID token", async () => {
    const { url } = await startAgentPass(config, binding);
    await expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { nonce: "other" } })), /validation failed/);
  });

  it("acr not in the accepted list", async () => {
    const { url } = await startAgentPass(config, binding);
    await expectNothing(
      await handleAgentPassCallback(config, approveInWorld(url, { claims: { acr: "https://world.org/oidc/acr/selfie" } })),
      /acr/,
    );
  });

  it("missing acr", async () => {
    const { url } = await startAgentPass(config, binding);
    await expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { acr: undefined } })), /acr/);
  });

  it("stale auth_time (older than maxAuthAgeSeconds)", async () => {
    const { url } = await startAgentPass(config, binding);
    const old = Math.floor(Date.now() / 1000) - 200;
    await expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { claims: { auth_time: old } })), /validation failed|too old/);
  });

  it("auth_time from before this attempt (a reused login)", async () => {
    const { url } = await startAgentPass(config, binding);
    const before = Math.floor(Date.now() / 1000) - 60;
    await expectNothing(
      await handleAgentPassCallback(config, approveInWorld(url, { claims: { auth_time: before } })),
      /predates/,
    );
  });

  it("ID token signed by a key not in the IdP's JWKS", async () => {
    const { url } = await startAgentPass(config, binding);
    await expectNothing(await handleAgentPassCallback(config, approveInWorld(url, { signWith: rogueKey })), /validation failed/);
  });
});
