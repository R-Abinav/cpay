// World Agent Pass (World IdP OIDC step-up) for "the agent wallet pays above its spend cap".
// Sources (fetched 5 Nov 2026): https://auth.world.org/docs/guides/human-in-the-loop,
// https://auth.world.org/docs/guides/oidc, https://auth.world.org/docs/guides/testing and
// https://auth.world.org/.well-known/openid-configuration.
//
// Runs only in the payer's own server (apps/web/app/api/agent-pass/*, apps/web/app/api/pay); never
// the issuer, never the browser. Production vs sandbox is the AGENT_PASS_ISSUER env value only
// (https://auth.world.org vs https://sandbox.auth.world.org); there is no code branch.
//
// Flow: startAgentPass(binding) -> redirect to url -> human approves in World App -> callback ->
// handleAgentPassCallback validates iss/state (library), code exchange with PKCE, ID token
// (RS256 signature against JWKS, iss, aud, exp, nonce, auth_time vs maxAge), then our own checks:
// acr is one of the accepted values, auth_time belongs to this attempt. On success a single-use
// approval for exactly {sessionId, amount, token} is recorded; /api/pay calls consumeApproval.
import * as oauth from "oauth4webapi";

/** The payment an approval unlocks. An approval for one binding can't be reused for another. */
export interface ApprovalBinding {
  sessionId: string;
  /** base units, canonical decimal */
  amount: string;
  token: string;
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
  /** lifetime of a pending attempt and of a single-use approval, seconds (default 300) */
  approvalTtlSeconds?: number;
  /** token endpoint client auth; the World portal default is client_secret_basic */
  tokenAuthMethod?: "client_secret_basic" | "client_secret_post";
  /** transport override (tests use an in-process fake IdP); defaults to global fetch */
  fetch?: typeof fetch;
  /** clock override (tests) */
  now?: () => number;
}

export interface AuthorizeRequest {
  url: string;
  state: string;
}

export interface ApprovalResult {
  approved: boolean;
  reason: string;
  binding?: ApprovalBinding;
}

// ---- state shared across Next route bundles (keyed on globalThis, see module note) ----

interface Pending {
  codeVerifier: string;
  nonce: string;
  binding: ApprovalBinding;
  /** seconds */
  startedAt: number;
  expiresAt: number;
}

interface Approval {
  expiresAt: number;
}

interface Store {
  pending: Map<string, Pending>;
  approvals: Map<string, Approval>;
  discovery: Map<string, Promise<oauth.AuthorizationServer>>;
}

const STORE_KEY = Symbol.for("cpay.world.agentPass.v1");
function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[STORE_KEY] ??= { pending: new Map(), approvals: new Map(), discovery: new Map() });
}

/** Tests only: forget every pending attempt, approval and cached discovery document. */
export function resetAgentPassState(): void {
  const s = store();
  s.pending.clear();
  s.approvals.clear();
  s.discovery.clear();
}

// ---- helpers ----

const CLOCK_SKEW = 5;

function nowSec(config: AgentPassConfig): number {
  return Math.floor((config.now?.() ?? Date.now()) / 1000);
}

function acrs(config: AgentPassConfig): string[] {
  const list = Array.isArray(config.acr) ? config.acr : [config.acr];
  if (list.length === 0 || list.some((a) => !a)) throw new Error("agent pass: at least one acr is required");
  return list;
}

function bindingKey(b: ApprovalBinding): string {
  return JSON.stringify([b.sessionId, b.amount, b.token.toLowerCase()]);
}

function checkBinding(b: ApprovalBinding): ApprovalBinding {
  if (typeof b.sessionId !== "string" || b.sessionId.length === 0 || b.sessionId.length > 128) {
    throw new Error("agent pass: bad sessionId");
  }
  if (typeof b.amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(b.amount)) throw new Error("agent pass: bad amount");
  if (typeof b.token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.token)) throw new Error("agent pass: bad token");
  return { sessionId: b.sessionId, amount: b.amount, token: b.token.toLowerCase() };
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
  for (const [k, v] of s.approvals) if (v.expiresAt <= t) s.approvals.delete(k);
}

const deny = (reason: string, binding?: ApprovalBinding): ApprovalResult =>
  binding ? { approved: false, reason, binding } : { approved: false, reason };

// ---- API ----

/**
 * Start a step-up for one over-cap payment. PKCE (S256) + fresh state + fresh nonce + max_age=0 +
 * essential acr claim. The binding stays server-side, keyed by state; it is never put in the URL.
 */
export async function startAgentPass(config: AgentPassConfig, binding: ApprovalBinding): Promise<AuthorizeRequest> {
  const b = checkBinding(binding);
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
    binding: b,
    startedAt: t,
    expiresAt: t + (config.approvalTtlSeconds ?? 300),
  });
  return { url: url.href, state };
}

/**
 * Handle the redirect back from World. Every failure (deny, cancel, IdP error, expired attempt,
 * replayed state, bad token, wrong acr, stale auth_time) returns approved: false and records nothing.
 * The attempt is single-use: it is removed before any network call.
 */
export async function handleAgentPassCallback(config: AgentPassConfig, callbackUrl: URL): Promise<ApprovalResult> {
  prune(config);
  const state = callbackUrl.searchParams.get("state");
  if (!state) return deny("missing state");
  const s = store();
  const pending = s.pending.get(state);
  if (!pending) return deny("unknown or expired attempt");
  s.pending.delete(state);
  if (pending.expiresAt <= nowSec(config)) return deny("attempt expired", pending.binding);

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
    if (!idt) return deny("no ID token", pending.binding);
    claims = idt;
  } catch (e) {
    if (e instanceof oauth.AuthorizationResponseError) return deny(`denied: ${e.error}`, pending.binding);
    if (e instanceof oauth.ResponseBodyError) return deny(`token error: ${e.error}`, pending.binding);
    return deny("validation failed", pending.binding);
  }

  if (typeof claims.acr !== "string" || !acrs(config).includes(claims.acr)) {
    return deny("insufficient assurance (acr)", pending.binding);
  }
  const t = nowSec(config);
  const authTime = claims.auth_time;
  if (typeof authTime !== "number") return deny("missing auth_time", pending.binding);
  if (authTime > t + CLOCK_SKEW) return deny("auth_time in the future", pending.binding);
  if (authTime < pending.startedAt - CLOCK_SKEW) return deny("authentication predates this request", pending.binding);
  if (t - authTime > (config.maxAuthAgeSeconds ?? 120)) return deny("authentication too old", pending.binding);

  s.approvals.set(bindingKey(pending.binding), { expiresAt: t + (config.approvalTtlSeconds ?? 300) });
  return { approved: true, reason: "approved", binding: pending.binding };
}

/** Single-use: true at most once per approval, and only for exactly this binding, before it expires. */
export function consumeApproval(binding: ApprovalBinding, now: number = Date.now()): boolean {
  let b: ApprovalBinding;
  try {
    b = checkBinding(binding);
  } catch {
    return false;
  }
  const s = store();
  const key = bindingKey(b);
  const a = s.approvals.get(key);
  if (!a) return false;
  s.approvals.delete(key);
  return a.expiresAt > Math.floor(now / 1000);
}

/** Drop a pending attempt (user pressed CANCEL on the glasses). Nothing is approved. */
export function cancelAgentPass(state: string): boolean {
  return store().pending.delete(state);
}
