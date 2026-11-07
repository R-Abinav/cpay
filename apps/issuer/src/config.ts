// Env -> IssuerOptions. Fails fast: no defaults for secrets, no fallback to fake verification.
import type { WorldEnvironment } from "./app.js";

export interface IssuerEnv {
  port: number;
  /** Supabase Postgres (pooled); empty = in-memory store (local dev only) */
  databaseUrl: string;
  rpId: string;
  rpSigningKey: string;
  bbsSecretKey: string;
  environment: WorldEnvironment;
  /** WORLD_ENVIRONMENTS (optional, comma-separated): every environment /enrol accepts; defaults to WORLD_ENVIRONMENT */
  environments: WorldEnvironment[];
  action: string;
  allowedOrigins: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`issuer: missing env ${name}`);
  return v;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): IssuerEnv {
  const environment = required(env, "WORLD_ENVIRONMENT");
  if (environment !== "staging" && environment !== "production") {
    throw new Error('issuer: WORLD_ENVIRONMENT must be "staging" or "production"');
  }
  const environments = (env.WORLD_ENVIRONMENTS?.trim() || environment).split(",").map((e) => e.trim()).filter(Boolean);
  for (const e of environments) {
    if (e !== "staging" && e !== "production") throw new Error('issuer: WORLD_ENVIRONMENTS entries must be "staging" or "production"');
  }
  const rpId = required(env, "WORLD_RP_ID");
  if (!/^rp_[0-9a-zA-Z]+$/.test(rpId)) throw new Error("issuer: WORLD_RP_ID must look like rp_...");
  return {
    port: Number(env.PORT ?? env.ISSUER_PORT ?? 8788),
    databaseUrl: env.DATABASE_URL?.trim() ?? "",
    rpId,
    rpSigningKey: required(env, "WORLD_RP_SIGNING_KEY"),
    bbsSecretKey: required(env, "ISSUER_BBS_SECRET_KEY"),
    environment,
    environments: environments as WorldEnvironment[],
    action: env.WORLD_ACTION?.trim() || env.NEXT_PUBLIC_WORLD_ACTION?.trim() || "cpay-recipient-v2",
    allowedOrigins: required(env, "ISSUER_ALLOWED_ORIGINS")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
