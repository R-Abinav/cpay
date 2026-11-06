// World Agent Pass (World IdP OIDC step-up) for "the agent wallet pays above its spend cap".
// Sources (fetched 5-6 Nov 2026): https://auth.world.org/docs/guides/human-in-the-loop,
// https://auth.world.org/docs/guides/oidc, https://auth.world.org/docs/guides/testing and
// https://auth.world.org/.well-known/openid-configuration.
//
// Runs only in the web server (apps/web/app/api/agent-pass/*); never the issuer, never the browser.
// Production vs sandbox is the AGENT_PASS_ISSUER env value only (https://auth.world.org vs
// https://sandbox.auth.world.org); there is no code branch.
//
// Two modes (docs/ARCHITECTURE.md onboarding step 5 + POLICY):
//   link:    once, from Settings. On success returns subHash = hex sha256(sub) to the phone, which keeps it.
//   approve: one over-cap payment. The phone sends only bindingCommit (a salted sha256 of the binding
//            {sessionId, amount, token, to}; salt and binding stay on the phone, @cpay/wallet
//            approvalBindingCommit) + its linked subHash. This server never sees the destination, amount,
//            token or session, so it holds no World-account -> payment link, even in memory. On success it
//            returns an Ed25519-signed approval token {v:2, jti, bindingCommit, subHash, exp}; the phone
//            verifies it (@cpay/wallet verifyApprovalToken: signature, recomputed commit, subHash, exp, jti).
// Flow: startAgentPass -> redirect to url -> human approves in World App -> callback ->
// handleAgentPassCallback validates iss/state (library), code exchange with PKCE, ID token
// (RS256 signature against JWKS, iss, aud, exp, nonce, auth_time vs maxAge), then our own checks:
// acr is one of the accepted values, auth_time belongs to this attempt, and (approve) the World account
// is the linked one. Pending attempts and results live in memory only, single-use, with a TTL. Nothing
// is persisted or logged.
import * as oauth from "oauth4webapi";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export type AgentPassRequest =
  | { mode: "link" }
  | {
      mode: "approve";
      /**
       * hex sha256 commitment to the payment, computed on the phone (@cpay/wallet approvalBindingCommit).
       * An approval for one commitment can't be reused for another payment: a different session, amount,
       * token, destination or salt fails the phone's check.
       */
      bindingCommit: string;
      /** the phone's linked hex sha256(sub) */
      subHash: string;
    };

/**
 * Approval token payload. Wire format (same as @cpay/wallet approval.ts):
 * "<b64url(JSON payload)>.<b64url(Ed25519 signature over 'cpay/v1/approval.' + b64url(JSON payload))>".
 */
export interface ApprovalPayload {
  v: 2;
  jti: string;
  bindingCommit: string;
  subHash: string;
  /** unix seconds */
  exp: number;
}

export interface AgentPassConfig {
  /** AGENT_PASS_ISSUER: https://auth.world.org (production) or https://sandbox.auth.world.org (sandbox) */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * Accepted acr value(s), requested as an essential claim and matched exactly on the ID token,
   * e.g. https://world.org/oidc/acr/orb. World treats each class as distinct, so list -face
   * variants too if you accept them.
   */
  acr: string | string[];
  /** max age of auth_time, seconds (default 120) */
  maxAuthAgeSeconds?: number;
  /** lifetime of a pending attempt, of a result waiting for pickup and of an approval token, seconds (default 300) */
  approvalTtlSeconds?: number;
  /** AGENT_PASS_APPROVAL_SECRET_KEY: Ed25519 secret key, 32 bytes hex (our operational key). Required for approve. */
  approvalSecretKey?: string;
  /** token endpoint client auth; the World portal default is client_secret_basic */
  tokenAuthMethod?: "client_secret_basic" | "client_secret_post";
  /** transport override (tests use an in-process fake IdP); defaults to global fetch */
  fetch?: typeof fetch;
  /** clock override (tests) */
  now?: () => number;
}

export interface AuthorizeRequest {
  url: string;
  /** also the attempt id the phone polls with */
  state: string;
}

/** Outcome of one attempt. Every failure is approved: false with a reason; nothing is signed. */
export type ApprovalResult =
  | { approved: false; reason: string; mode?: AgentPassRequest["mode"] }
  | { approved: true; reason: string; mode: "link"; subHash: string }
  | { approved: true; reason: string; mode: "approve"; bindingCommit: string; subHash: string; token: string };

/** What the phone sees when it polls an attempt. Final results are handed out once, then forgotten. */
export type AgentPassStatus = { state: "none" } | { state: "pending" } | ({ state: "done" } & ApprovalResult);

// ---- state shared across Next route bundles (keyed on globalThis) ----

interface Pending {
  codeVerifier: string;
  nonce: string;
  req: AgentPassRequest;
  /** seconds */
  startedAt: number;
  expiresAt: number;
}

interface Done {
  result: ApprovalResult;
  expiresAt: number;
}

interface Store {
  pending: Map<string, Pending>;
  results: Map<string, Done>;
  discovery: Map<string, Promise<oauth.AuthorizationServer>>;
}

const STORE_KEY = Symbol.for("cpay.world.agentPass.v2");
function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[STORE_KEY] ??= { pending: new Map(), results: new Map(), discovery: new Map() });
}

/** Tests only: forget every pending attempt, result and cached discovery document. */
export function resetAgentPassState(): void {
  const s = store();
  s.pending.clear();
  s.results.clear();
  s.discovery.clear();
}

// ---- helpers ----

const CLOCK_SKEW = 5;
const HASH_RE = /^[0-9a-f]{64}$/;
const APPROVAL_DOMAIN = "cpay/v1/approval.";

function nowSec(config: Pick<AgentPassConfig, "now">): number {
  return Math.floor((config.now?.() ?? Date.now()) / 1000);
}

function acrs(config: AgentPassConfig): string[] {
  const list = Array.isArray(config.acr) ? config.acr : [config.acr];
  if (list.length === 0 || list.some((a) => !a)) throw new Error("agent pass: at least one acr is required");
  return list;
}

function checkRequest(req: AgentPassRequest): AgentPassRequest {
  if (req?.mode === "link") return { mode: "link" };
  if (req?.mode === "approve") {
    const subHash = typeof req.subHash === "string" ? req.subHash.toLowerCase() : "";
    if (!HASH_RE.test(subHash)) throw new Error("agent pass: bad subHash (link World first)");
    const bindingCommit = typeof req.bindingCommit === "string" ? req.bindingCommit.toLowerCase() : "";
    if (!HASH_RE.test(bindingCommit)) throw new Error("agent pass: bad bindingCommit");
    return { mode: "approve", bindingCommit, subHash };
  }
  throw new Error("agent pass: mode must be link or approve");
}

/** hex sha256(sub): what the phone stores at link time and what approvals must carry. */
export function subHashOf(sub: string): string {
  return bytesToHex(sha256(utf8ToBytes(sub)));
}

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secretKeyBytes(hex: string | undefined): Uint8Array {
  const h = hex?.trim().replace(/^0x/, "") ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("agent pass: AGENT_PASS_APPROVAL_SECRET_KEY must be 32 bytes hex");
  return hexToBytes(h);
}

/** Sign an approval token (our operational Ed25519 key, never a user key). */
export function signApprovalToken(payload: ApprovalPayload, secretKeyHex: string): string {
  const body = b64u(utf8ToBytes(JSON.stringify(payload)));
  const sig = ed25519.sign(utf8ToBytes(APPROVAL_DOMAIN + body), secretKeyBytes(secretKeyHex));
  return `${body}.${b64u(sig)}`;
}

/** Hex Ed25519 public key for NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY. */
export function approvalPublicKeyHex(secretKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(secretKeyBytes(secretKeyHex)));
}

function httpOptions<M, B = undefined>(config: AgentPassConfig): oauth.HttpRequestOptions<M, B> {
  const opts: oauth.HttpRequestOptions<M, B> = {
    signal: () => AbortSignal.timeout(10_000),
  };
  if (config.fetch) {
    const f = config.fetch;
    opts[oauth.customFetch] = (url, o) => f(url, o as RequestInit);
  }
  return opts;
}

function client(config: AgentPassConfig): oauth.Client {
  const c: oauth.Client = { client_id: config.clientId, id_token_signed_response_alg: "RS256" };
  c[oauth.clockSkew] = 0;
  c[oauth.clockTolerance] = CLOCK_SKEW;
  return c;
}

function clientAuth(config: AgentPassConfig): oauth.ClientAuth {
  return config.tokenAuthMethod === "client_secret_post"
    ? oauth.ClientSecretPost(config.clientSecret)
    : oauth.ClientSecretBasic(config.clientSecret);
}

async function discover(config: AgentPassConfig): Promise<oauth.AuthorizationServer> {
  const s = store();
  let p = s.discovery.get(config.issuer);
  if (!p) {
    const issuer = new URL(config.issuer);
    p = oauth
      .discoveryRequest(issuer, { ...httpOptions<"GET">(config), algorithm: "oidc" })
      .then((res) => oauth.processDiscoveryResponse(issuer, res));
    s.discovery.set(config.issuer, p);
    p.catch(() => s.discovery.delete(config.issuer));
  }
  return p;
}

function prune(config: AgentPassConfig): void {
  const t = nowSec(config);
  const s = store();
  for (const [k, v] of s.pending) if (v.expiresAt <= t) s.pending.delete(k);
  for (const [k, v] of s.results) if (v.expiresAt <= t) s.results.delete(k);
}

function deny(reason: string, req?: AgentPassRequest): ApprovalResult {
  if (!req) return { approved: false, reason };
  return { approved: false, reason, mode: req.mode };
}

// ---- API ----

/**
 * Start a step-up: link (once) or approve (one over-cap payment). PKCE (S256) + fresh state + fresh
 * nonce + max_age=0 + essential acr claim. The binding commitment stays server-side, keyed by state;
 * it is never put in the URL.
 */
export async function startAgentPass(config: AgentPassConfig, request: AgentPassRequest): Promise<AuthorizeRequest> {
  const req = checkRequest(request);
  if (req.mode === "approve") secretKeyBytes(config.approvalSecretKey); // fail before the human does anything
  const accepted = acrs(config);
  prune(config);
  const as = await discover(config);
  if (!as.authorization_endpoint) throw new Error("agent pass: IdP has no authorization_endpoint");

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("max_age", "0");
  url.searchParams.set("claims", JSON.stringify({ id_token: { acr: { essential: true, values: accepted } } }));

  const t = nowSec(config);
  store().pending.set(state, {
    codeVerifier,
    nonce,
    req,
    startedAt: t,
    expiresAt: t + (config.approvalTtlSeconds ?? 300),
  });
  return { url: url.href, state };
}

/**
 * Handle the redirect back from World. Every failure (deny, cancel, IdP error, expired attempt,
 * replayed state, bad token, wrong acr, stale auth_time, a different World account) returns
 * approved: false and signs nothing. The attempt is single-use: it is removed before any network call.
 * The result is also kept (memory, TTL) for the phone to pick up once with takeAgentPassResult(state).
 */
export async function handleAgentPassCallback(config: AgentPassConfig, callbackUrl: URL): Promise<ApprovalResult> {
  prune(config);
  const state = callbackUrl.searchParams.get("state");
  if (!state) return deny("missing state");
  const s = store();
  const pending = s.pending.get(state);
  if (!pending) return deny("unknown or expired attempt");
  s.pending.delete(state);
  const result = await validate(config, callbackUrl, state, pending);
  s.results.set(state, { result, expiresAt: nowSec(config) + (config.approvalTtlSeconds ?? 300) });
  return result;
}

async function validate(config: AgentPassConfig, callbackUrl: URL, state: string, pending: Pending): Promise<ApprovalResult> {
  const req = pending.req;
  if (pending.expiresAt <= nowSec(config)) return deny("attempt expired", req);

  let claims: oauth.IDToken;
  try {
    const as = await discover(config);
    const c = client(config);
    // Validates iss (RFC 9207, advertised by World) and state; throws on error=... responses.
    const params = oauth.validateAuthResponse(as, c, callbackUrl, state);
    const res = await oauth.authorizationCodeGrantRequest(
      as,
      c,
      clientAuth(config),
      params,
      config.redirectUri,
      pending.codeVerifier,
      httpOptions<"POST", URLSearchParams>(config),
    );
    const maxAge = config.maxAuthAgeSeconds ?? 120;
    const tokens = await oauth.processAuthorizationCodeResponse(as, c, res, {
      expectedNonce: pending.nonce,
      maxAge,
      requireIdToken: true,
    });
    // World: "RS256, with keys from jwks_uri". Check the signature too, not only TLS.
    await oauth.validateApplicationLevelSignature(as, res, httpOptions<"GET">(config));
    const idt = oauth.getValidatedIdTokenClaims(tokens);
    if (!idt) return deny("no ID token", req);
    claims = idt;
  } catch (e) {
    if (e instanceof oauth.AuthorizationResponseError) return deny(`denied: ${e.error}`, req);
    if (e instanceof oauth.ResponseBodyError) return deny(`token error: ${e.error}`, req);
    return deny("validation failed", req);
  }

  if (typeof claims.acr !== "string" || !acrs(config).includes(claims.acr)) {
    return deny("insufficient assurance (acr)", req);
  }
  const t = nowSec(config);
  const authTime = claims.auth_time;
  if (typeof authTime !== "number") return deny("missing auth_time", req);
  if (authTime > t + CLOCK_SKEW) return deny("auth_time in the future", req);
  if (authTime < pending.startedAt - CLOCK_SKEW) return deny("authentication predates this request", req);
  if (t - authTime > (config.maxAuthAgeSeconds ?? 120)) return deny("authentication too old", req);
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return deny("missing sub", req);

  const subHash = subHashOf(claims.sub);
  if (req.mode === "link") return { approved: true, reason: "linked", mode: "link", subHash };

  // The human who approved must be the one linked on this phone (guide: the (iss, sub) pair must match).
  if (subHash !== req.subHash) return deny("a different World account than the one linked", req);
  const payload: ApprovalPayload = {
    v: 2,
    jti: bytesToHex(randomBytes(16)),
    bindingCommit: req.bindingCommit,
    subHash,
    exp: t + (config.approvalTtlSeconds ?? 300),
  };
  const token = signApprovalToken(payload, config.approvalSecretKey ?? "");
  return { approved: true, reason: "approved", mode: "approve", bindingCommit: req.bindingCommit, subHash, token };
}

/**
 * The phone polls its attempt: pending while the human is in World App, then the final result exactly
 * once (it is deleted on pickup). Unknown or expired attempts are "none".
 */
export function takeAgentPassResult(state: string, config: Pick<AgentPassConfig, "now"> = {}): AgentPassStatus {
  const s = store();
  const t = nowSec(config);
  const done = s.results.get(state);
  if (done) {
    s.results.delete(state);
    return done.expiresAt > t ? { state: "done", ...done.result } : { state: "none" };
  }
  const p = s.pending.get(state);
  if (p && p.expiresAt > t) return { state: "pending" };
  return { state: "none" };
}

/** Drop a pending attempt (user pressed Stop). Nothing is approved; a late callback finds no attempt. */
export function cancelAgentPass(state: string): boolean {
  return store().pending.delete(state);
}
