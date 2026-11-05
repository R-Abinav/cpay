// @cpay/world: IDKit 4 request helpers (Proof of Human) + World Agent Pass OIDC step-up helpers.
// STUB: interfaces only, owned by the identity agent. Every function throws until implemented.
// Production vs staging is an env switch only (WORLD_ENVIRONMENT), never a code branch.

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export type WorldEnvironment = "staging" | "production";

export const WORLD_ACTION = "cpay-recipient-v1";

// ---- IDKit (recipient onboarding) ----

export interface IdkitRequestParams {
  appId: string;
  action: string;
  /** hash(commitment) from @cpay/credential */
  signal: string;
  environment: WorldEnvironment;
}

/** Shape of what the web app passes to the IDKit widget; finalised against the IDKit 4 docs. */
export interface IdkitRequestConfig {
  appId: string;
  action: string;
  signal: string;
  environment: WorldEnvironment;
  /** RP signature fetched from the issuer's POST /rp-signature */
  rpSignature: unknown;
}

/** The IDKit result, forwarded unchanged to the issuer. */
export type IdkitResult = Record<string, unknown>;

export function buildIdkitRequest(_params: IdkitRequestParams, _issuerUrl: string): Promise<IdkitRequestConfig> {
  return notImplemented();
}

// ---- Agent Pass (over-cap step-up) ----

/** The payment an approval unlocks. An approval for one binding can't be reused for another. */
export interface ApprovalBinding {
  sessionId: string;
  /** base units */
  amount: string;
  token: string;
}

export interface AgentPassConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** essential acr value, e.g. https://world.org/oidc/acr/orb */
  acr: string;
  /** max age of auth_time, seconds (~120) */
  maxAuthAgeSeconds?: number;
  /** single-use approval lifetime, seconds (~300) */
  approvalTtlSeconds?: number;
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

/** PKCE + state + nonce + max_age=0 + essential acr; binding kept server-side keyed by state. */
export function startAgentPass(_config: AgentPassConfig, _binding: ApprovalBinding): Promise<AuthorizeRequest> {
  return notImplemented();
}

/** Validates state, nonce, acr and auth_time freshness. Deny/cancel/expired => approved: false. */
export function handleAgentPassCallback(_config: AgentPassConfig, _callbackUrl: URL): Promise<ApprovalResult> {
  return notImplemented();
}

/** Single-use: true at most once per approval, and only for exactly this binding. */
export function consumeApproval(_binding: ApprovalBinding): boolean {
  return notImplemented();
}
