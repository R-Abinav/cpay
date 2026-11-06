// Relay wire schema + sealed bodies. Every message crossing a trust boundary is parsed with these.
import { z } from "zod";

export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_PROBE_ITEMS = 64;

export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32-byte lowercase hex");
export const X25519Pub = Hex32;
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x address");
export const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "expected base64");
export const PeerId = z.string().min(1).max(64);
export const SessionId = z.uuid();
export const UintString = z.string().regex(/^(0|[1-9][0-9]*)$/, "expected canonical decimal");

export const BoxSchema = z.strictObject({
  iv: Base64.max(24),
  ct: Base64.max(MAX_PAYLOAD_BYTES),
});

// ---- client -> relay ----
/**
 * Register as a recipient. `proof` is a BBS presentation of the World ID card (@cpay/credential prove) bound to
 * relayHelloDigest(challenge.nonce, pub): only verified humans can be probed. Reveals tier + epoch to the relay.
 */
export const RecipientHello = z.strictObject({
  type: z.literal("recipient.hello"),
  pub: X25519Pub,
  proof: z.string().min(1).max(64 * 1024),
});
export const PayerHello = z.strictObject({ type: z.literal("payer.hello") });
export const ProbeRequest = z.strictObject({
  type: z.literal("probe"),
  sessionId: SessionId,
  payerPub: X25519Pub,
  items: z.array(z.strictObject({ peerId: PeerId, box: BoxSchema })).min(1).max(MAX_PROBE_ITEMS),
});
export const ClaimRequest = z.strictObject({ type: z.literal("claim"), sessionId: SessionId, box: BoxSchema });

export const ClientMessage = z.discriminatedUnion("type", [RecipientHello, PayerHello, ProbeRequest, ClaimRequest]);

// ---- relay -> client ----
export const PeersMessage = z.strictObject({
  type: z.literal("peers"),
  peers: z.array(z.strictObject({ peerId: PeerId, pub: X25519Pub })),
});
export const ProbeDelivery = z.strictObject({
  type: z.literal("probe"),
  sessionId: SessionId,
  payerPub: X25519Pub,
  box: BoxSchema,
});
export const ClaimDelivery = z.strictObject({ type: z.literal("claim"), sessionId: SessionId, box: BoxSchema });
/** Sent once after recipient.hello: this connection's relay peerId (needed for the CPay QR). */
export const RecipientReady = z.strictObject({ type: z.literal("recipient.ready"), peerId: PeerId });
export const ErrorMessage = z.strictObject({ type: z.literal("error"), message: z.string().max(200) });
/** Sent once, first, on every connection: the fresh nonce a recipient.hello proof must be bound to. */
export const RelayChallenge = z.strictObject({ type: z.literal("challenge"), nonce: Hex32 });

export const RelayMessage = z.discriminatedUnion("type", [
  RelayChallenge,
  PeersMessage,
  RecipientReady,
  ProbeDelivery,
  ClaimDelivery,
  ErrorMessage,
]);

// ---- sealed bodies ----
export const ProbeBodySchema = z.strictObject({
  v: z.literal(1),
  sessionNonce: Hex32,
  /** base64 of little-endian Float32 values */
  embedding: Base64.min(1),
  chainId: z.number().int().positive(),
  token: Address,
  /** base units */
  amount: UintString,
  mode: z.enum(["lite", "full"]),
});

export const ClaimBodySchema = z.strictObject({
  v: z.literal(1),
  sessionNonce: Hex32,
  destination: Address,
  /** opaque serialised BBS presentation from @cpay/credential */
  credentialProof: z.string().min(1).max(64 * 1024),
});

export type Box = z.infer<typeof BoxSchema>;
export type ClientMessage = z.infer<typeof ClientMessage>;
export type RelayMessage = z.infer<typeof RelayMessage>;
export type RecipientHello = z.infer<typeof RecipientHello>;
export type PayerHello = z.infer<typeof PayerHello>;
export type ProbeRequest = z.infer<typeof ProbeRequest>;
export type ClaimRequest = z.infer<typeof ClaimRequest>;
export type PeersMessage = z.infer<typeof PeersMessage>;
export type ProbeDelivery = z.infer<typeof ProbeDelivery>;
export type ClaimDelivery = z.infer<typeof ClaimDelivery>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;
export type RecipientReady = z.infer<typeof RecipientReady>;
export type RelayChallenge = z.infer<typeof RelayChallenge>;
export type ProbeBody = z.infer<typeof ProbeBodySchema>;
export type ClaimBody = z.infer<typeof ClaimBodySchema>;
export type Mode = ProbeBody["mode"];
