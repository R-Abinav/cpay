/**
 * Hub tickets. CONTRACT FILE: change only in its own commit.
 * Issued by cpay-hub to an authenticated phone; checked by cpay-web (/api/intent, /api/transcribe)
 * before spending 0G credits. Server-only (node:crypto). Holds no unit id, owner token or user data.
 *
 * token = base64url(JSON{v:1, id, exp}) + "." + base64url(HMAC-SHA256(HUB_TICKET_SECRET, payloadPart))
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface TicketClaims {
  v: 1;
  /** Random ticket id (rate limiting key). */
  id: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function mac(secret: string, payload: string): Buffer {
  if (!secret || secret.length < 32) throw new Error("HUB_TICKET_SECRET missing or too short");
  return createHmac("sha256", secret).update(payload).digest();
}

export function issueTicket(secret: string, ttlSeconds: number, nowMs = Date.now()): { token: string; claims: TicketClaims } {
  const claims: TicketClaims = { v: 1, id: randomBytes(16).toString("hex"), exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${payload}.${mac(secret, payload).toString("base64url")}`, claims };
}

/** Returns the claims if the signature is valid and not expired, else null. Never throws on bad input. */
export function verifyTicket(token: unknown, secret: string, nowMs = Date.now()): TicketClaims | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const expected = mac(secret, payload);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TicketClaims;
    if (c.v !== 1 || typeof c.id !== "string" || typeof c.exp !== "number") return null;
    if (c.exp * 1000 <= nowMs) return null;
    return c;
  } catch {
    return null;
  }
}
