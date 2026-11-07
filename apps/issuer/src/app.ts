// @cpay/issuer: World ID (IDKit 4) verify -> nullifier store -> BBS blind issuance.
// Stores exactly three things: (nullifier, action, commitment_hash) rows, the World RP signing key, the
// BBS issuer secret key (the two keys in env only). Never sees faces, wallets or payments. Logs: method + path + status only.
import { Hono } from "hono";
import { z } from "zod";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { commitmentHash, commitmentSignal, currentEpoch, issueBlind, issuerPublicKey, type BlindSignature } from "@cpay/credential";
import { StoreError, normaliseNullifier, type NullifierStore } from "./db.js";

export type WorldEnvironment = "staging" | "production";

export const WORLD_VERIFY_BASE = "https://developer.world.org";
/**
 * Only World ID 4.0 Proof of Human (issuer_schema_id 1). Legacy 3.0 proofs are refused: a v3 and a
 * v4 proof from the same human carry different nullifiers, so accepting both would allow two cards
 * per human (the request is built with allow_legacy_proofs: false for the same reason).
 */
const PROOF_OF_HUMAN = { identifier: "proof_of_human", issuerSchemaId: 1 } as const;

export interface IssuerOptions {
  store: NullifierStore;
  /** WORLD_RP_ID (rp_...) */
  rpId: string;
  /** WORLD_RP_SIGNING_KEY, hex */
  rpSigningKey: string;
  /** ISSUER_BBS_SECRET_KEY, base64 */
  bbsSecretKey: string;
  /** WORLD_ENVIRONMENT (the primary one, reported by /health) */
  environment: WorldEnvironment;
  /** WORLD_ENVIRONMENTS: every environment /enrol accepts (default: [environment]). Each proof is verified with World in its own environment. */
  environments?: WorldEnvironment[];
  /** NEXT_PUBLIC_WORLD_ACTION, e.g. cpay-recipient-v1 */
  action: string;
  /** ISSUER_ALLOWED_ORIGINS */
  allowedOrigins: string[];
  /** Injected only by tests (a local fake server). Production always uses WORLD_VERIFY_BASE. */
  verifyBase?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Response of POST /rp-signature: signRequest's output (snake_case, per the IDKit guide) + rp_id. */
export interface RpSignatureResponse {
  rp_id: string;
  sig: string;
  nonce: string;
  created_at: number;
  expires_at: number;
}

/** POST /enrol body. The IDKit result is forwarded to World unchanged, so it stays an open record here. */
const EnrolBody = z.object({
  idkitResult: z.record(z.string(), z.unknown()),
  commitment: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9+/=]+$/),
});
const ForgetBody = z.object({ commitment: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9+/=]+$/) });
const RpSignatureBody = z.object({ action: z.string().max(128).optional() }).catch({});

class EnrolError extends Error {
  constructor(
    readonly status: 400 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameField(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

export function createIssuerApp(opts: IssuerOptions): Hono {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((l: string) => console.log(l));
  const verifyBase = opts.verifyBase ?? WORLD_VERIFY_BASE;
  const publicKey = issuerPublicKey(opts.bbsSecretKey);
  const accepted: WorldEnvironment[] = opts.environments?.length ? opts.environments : [opts.environment];
  const app = new Hono();

  // Method + path + status. No IPs, no bodies, no query strings, no headers.
  app.use(async (c, next) => {
    await next();
    log(`[issuer] ${c.req.method} ${c.req.path} ${c.res.status}`);
  });
  app.use(cors({ origin: opts.allowedOrigins, allowMethods: ["GET", "POST"], allowHeaders: ["content-type"] }));
  app.use(bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }));

  app.get("/health", async (c) => {
    try {
      await opts.store.ping();
    } catch {
      return c.json({ ok: false, environment: opts.environment, db: "unreachable" }, 503);
    }
    return c.json({ ok: true, environment: opts.environment });
  });

  app.get("/issuer-key", (c) => c.json({ publicKey }));

  app.post("/rp-signature", async (c) => {
    const body = RpSignatureBody.parse(await c.req.json().catch(() => ({})));
    const action = body.action ?? opts.action;
    if (action !== opts.action) return c.json({ error: "unknown action" }, 400);
    // signRequest generates a fresh random nonce on every call.
    const sig = signRequest({ signingKeyHex: opts.rpSigningKey, action });
    const res: RpSignatureResponse = {
      rp_id: opts.rpId,
      sig: sig.sig,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
    };
    return c.json(res);
  });

  app.post("/enrol", async (c) => {
    try {
      const parsed = EnrolBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new EnrolError(400, "expected {idkitResult, commitment}");
      const idkitResult = parsed.data.idkitResult;
      const commitment = parsed.data.commitment;

      // 1. Local checks before calling World.
      const env = accepted.find((e) => e === idkitResult.environment);
      if (!env) throw new EnrolError(400, "wrong World environment");
      if (idkitResult.action !== opts.action) throw new EnrolError(400, "wrong action");
      if ("session_id" in idkitResult) throw new EnrolError(400, "session proofs are not accepted");
      const responses = idkitResult.responses;
      if (!Array.isArray(responses) || responses.length !== 1 || !isObj(responses[0])) {
        throw new EnrolError(400, "expected exactly one credential response");
      }
      const item = responses[0];
      if (idkitResult.protocol_version !== "4.0") throw new EnrolError(400, "World ID 4.0 proof required");
      if (item.identifier !== PROOF_OF_HUMAN.identifier || item.issuer_schema_id !== PROOF_OF_HUMAN.issuerSchemaId) {
        throw new EnrolError(400, "credential must be Proof of Human");
      }
      const expectedSignalHash = hashSignal(commitmentSignal(commitment));
      if (typeof item.signal_hash !== "string" || !sameField(item.signal_hash, expectedSignalHash)) {
        throw new EnrolError(400, "signal does not match commitment");
      }
      if (typeof item.nullifier !== "string") throw new EnrolError(400, "missing nullifier");
      let nullifier: string;
      try {
        nullifier = normaliseNullifier(item.nullifier);
      } catch {
        throw new EnrolError(400, "bad nullifier");
      }

      // 2. Blind-sign in memory. Simulator (staging) proofs get tier "staging", never "orb": payers can tell them apart.
      //    (also verifies the commitment's proof of knowledge). Released
      //    only after World verifies and the nullifier is fresh.
      let blind: BlindSignature;
      try {
        blind = await issueBlind(opts.bbsSecretKey, commitment, { tier: env === "production" ? "orb" : "staging", epoch: currentEpoch(opts.now?.()) });
      } catch {
        throw new EnrolError(400, "invalid commitment");
      }

      // 3. World verify: forward the IDKit result unchanged, in the (accepted) environment it was made in.
      let verification: unknown;
      try {
        const res = await doFetch(`${verifyBase}/api/v4/verify/${encodeURIComponent(opts.rpId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...idkitResult, environment: env }),
          signal: AbortSignal.timeout(10_000),
        });
        verification = await res.json().catch(() => null);
      } catch {
        throw new EnrolError(502, "World verify unreachable");
      }
      if (!isObj(verification) || verification.success !== true) {
        const code = isObj(verification) && typeof verification.code === "string" ? verification.code : "unknown";
        // World refuses a second verification of the same human for this action. If that human already holds a
        // card here with the SAME commitment C (same passkey: restored wallet, new phone, cleared storage), re-sign it,
        // exactly as a fresh verify would ("same" below). Safe without World's verdict: matching needs C, which only
        // the holder knows, and the blind signature is useless without the holder secret s behind C.
        if (/replay|already|max_verif|duplicate/i.test(code)) {
          const stored = await opts.store.lookup(nullifier, opts.action);
          if (stored !== null && stored === commitmentHash(commitment)) return c.json(blind);
          if (stored !== null) throw new EnrolError(409, "This World ID already has a card on another CPay wallet (another passkey).");
          throw new EnrolError(409, "World says this World ID was already used for CPay, and we hold no card for it to restore.");
        }
        throw new EnrolError(400, `World verification failed: ${code}`);
      }
      if (verification.environment !== env) throw new EnrolError(400, "World verify environment mismatch");
      // If World echoes a nullifier, it must be the one we are about to store.
      const echoed = [
        verification.nullifier,
        ...(Array.isArray(verification.results) ? verification.results.map((r) => (isObj(r) ? r.nullifier : undefined)) : []),
      ].filter((n): n is string => typeof n === "string");
      for (const n of echoed) {
        let norm: string | undefined;
        try {
          norm = normaliseNullifier(n);
        } catch {
          norm = undefined;
        }
        if (norm !== nullifier) throw new EnrolError(400, "World verify nullifier mismatch");
      }

      // 4. One card per human per action. The same holder (same commitment C, i.e. the same passkey on a
      //    new phone) is re-signed: no extra sybil power. A different C for a used nullifier is refused.
      const claim = await opts.store.claim(nullifier, opts.action, commitmentHash(commitment));
      if (claim === "conflict") throw new EnrolError(409, "already enrolled");
      return c.json(blind);
    } catch (e) {
      if (e instanceof EnrolError) return c.json({ error: e.message }, e.status);
      // Short code only: never the raw error (it can carry connection details or values).
      log(`[issuer] enrol error ${e instanceof StoreError ? e.code : "internal"}`);
      return c.json({ error: e instanceof StoreError ? "database unavailable" : "internal error" }, e instanceof StoreError ? 503 : 500);
    }
  });

  // Restore a card without World App. World App refuses a second proof for the same action (it remembers its
  // nullifiers), so a holder who lost the card (restored wallet, new phone) can't re-verify. If this exact commitment
  // C was already World-verified here, re-sign it. Safe: only the holder knows C, the proof of knowledge is checked,
  // and the blind signature is useless without the holder secret s. No new sybil power (same human, same C).
  // Tier: the row doesn't record the environment, so the restored card says "staging" (never over-claims "orb").
  app.post("/reissue", async (c) => {
    const parsed = ForgetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "expected {commitment}" }, 400);
    let blind: BlindSignature;
    try {
      blind = await issueBlind(opts.bbsSecretKey, parsed.data.commitment, { tier: "staging", epoch: currentEpoch(opts.now?.()) });
    } catch {
      return c.json({ error: "invalid commitment" }, 400);
    }
    try {
      if (!(await opts.store.hasCommitment(commitmentHash(parsed.data.commitment)))) return c.json({ error: "no card to restore" }, 404);
    } catch (e) {
      log(`[issuer] reissue error ${e instanceof StoreError ? e.code : "internal"}`);
      return c.json({ error: "database unavailable" }, 503);
    }
    return c.json(blind);
  });

  // "Delete my account": the holder sends its commitment C (the same blob as /enrol, with its proof of
  // knowledge) and every nullifier row with hash(C) is deleted. Only the holder knows C. Nothing is logged
  // beyond method + path + status.
  app.post("/forget", async (c) => {
    const parsed = ForgetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "expected {commitment}" }, 400);
    try {
      // Checks the proof of knowledge of C's opening; the signature is discarded.
      await issueBlind(opts.bbsSecretKey, parsed.data.commitment, { tier: "forget", epoch: currentEpoch(opts.now?.()) });
    } catch {
      return c.json({ error: "invalid commitment" }, 400);
    }
    try {
      const deleted = await opts.store.forget(commitmentHash(parsed.data.commitment));
      return c.json({ ok: true, deleted });
    } catch (e) {
      log(`[issuer] forget error ${e instanceof StoreError ? e.code : "internal"}`);
      return c.json({ error: "database unavailable" }, 503);
    }
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
