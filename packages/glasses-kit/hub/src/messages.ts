/**
 * CPay glasses hub: wire contract (protocol 3). CONTRACT FILE: change only in its own commit.
 *
 * Browser-safe: imports only zod. The PWA imports it as `@cpay/glasses-kit/hub`.
 *
 *   phone (PWA)  <── wss://<hub>/phone  (JSON, `type`) ──>  hub  <── wss://<hub>/device (JSON `t` + binary JPEG) ──>  ESP32-CAM
 *
 * One device per glasses unit (the ESP32-CAM drives camera + OLED). No buttons: the phone drives the
 * session (`scan`), the hub forwards frames to the paired phone only, memory only, then drops them.
 * See docs/ARCHITECTURE.md (1) pairing and (2) paying.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 3 as const;

/** Hard limits the hub enforces. */
export const LIMITS = {
  /** A stream stops this long after the last `scan{on}` unless refreshed (privacy: camera never left on). */
  streamMaxMs: 15_000,
  /** Largest JPEG frame the hub forwards (QVGA software JPEG is ~8-15 KB). */
  frameMaxBytes: 64 * 1024,
  /** Largest JSON message from a phone or device. */
  jsonMaxBytes: 4 * 1024,
  /** Pairing code lifetime default (HUB_PAIRING_CODE_TTL_SECONDS overrides). */
  pairingCodeTtlSeconds: 300,
} as const;

// ---------------------------------------------------------------- shared pieces

/** 6 chars, no lookalikes (no 0/O/1/I). Shown on the OLED, typed in Settings. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PairingCode = z.string().regex(/^[A-HJ-NP-Z2-9]{6}$/, "6-char pairing code");

/** Random 32 bytes as hex, generated and kept on the phone. The hub stores only sha256(ownerToken). */
export const OwnerToken = z.string().regex(/^[0-9a-f]{64}$/, "64 hex chars");

/** 128x64 SSD1306: up to 4 lines of up to 21 printable ASCII chars (6x10 font). The firmware uses a big
 * font automatically when there are <= 2 lines of <= 10 chars (e.g. the confirm code). */
export const OLED_MAX_LINES = 4;
export const OLED_MAX_CHARS = 21;
export const OledLine = z
  .string()
  .max(OLED_MAX_CHARS)
  .regex(/^[\x20-\x7E]*$/, "printable ASCII only");
export const OledLines = z.array(OledLine).min(1).max(OLED_MAX_LINES);
export type OledLines = z.infer<typeof OledLines>;

// ---------------------------------------------------------------- phone -> hub (/phone)

/** First message on a new phone: claim the unit showing `code`. Answer: `hello` or `error`. */
export const PairMessage = z.object({ type: z.literal("pair"), code: PairingCode, ownerToken: OwnerToken });
/** First message on every later connection. Answer: `hello` or `error{unauthorized}`. */
export const AuthMessage = z.object({ type: z.literal("auth"), ownerToken: OwnerToken });
/** Start/stop the camera. `on:true` must be re-sent at least every `LIMITS.streamMaxMs` to keep streaming. */
export const ScanMessage = z.object({ type: z.literal("scan"), on: z.boolean() });
/** Text for the glasses OLED. Last write wins; replayed when the device reconnects. */
export const OledMessage = z.object({ type: z.literal("oled"), lines: OledLines });
/** Ask for a fresh hub ticket (for /api/intent and /api/transcribe). */
export const TicketRequestMessage = z.object({ type: z.literal("ticket_request") });
/** Forget this pairing (clears owner_token_hash). The unit shows a new pairing code. */
export const UnpairMessage = z.object({ type: z.literal("unpair") });

export const PhoneToHub = z.discriminatedUnion("type", [
  PairMessage,
  AuthMessage,
  ScanMessage,
  OledMessage,
  TicketRequestMessage,
  UnpairMessage,
]);
export type PhoneToHub = z.infer<typeof PhoneToHub>;

// ---------------------------------------------------------------- hub -> phone

/** After a successful pair/auth. `online` = the glasses are connected to the hub right now. */
export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  online: z.boolean(),
});
export const DeviceStatusMessage = z.object({ type: z.literal("device_status"), online: z.boolean() });
/** One camera frame. Forwarded and dropped by the hub; the phone decodes QR locally and drops it too. */
export const FrameMessage = z.object({
  type: z.literal("frame"),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  mime: z.literal("image/jpeg"),
  dataBase64: z.string().min(1),
});
/** Stream state changes, including the hub's own stop (15 s cap) or the device dropping. */
export const ScanStateMessage = z.object({
  type: z.literal("scan_state"),
  on: z.boolean(),
  reason: z.enum(["phone", "timeout", "device_offline"]),
});
/** HMAC ticket for /api/intent and /api/transcribe. Opaque to the phone. */
export const TicketMessage = z.object({ type: z.literal("ticket"), token: z.string().min(1), exp: z.number().int() });
export const HubErrorCode = z.enum([
  "bad_message", // failed zod validation or too big
  "bad_code", // unknown, used or expired pairing code
  "unauthorized", // unknown owner token
  "not_authenticated", // sent something before pair/auth
  "device_offline", // scan/oled while the glasses are offline
  "rate_limited",
]);
export const ErrorMessage = z.object({ type: z.literal("error"), code: HubErrorCode, detail: z.string().optional() });

export const HubToPhone = z.discriminatedUnion("type", [
  HelloMessage,
  DeviceStatusMessage,
  FrameMessage,
  ScanStateMessage,
  TicketMessage,
  ErrorMessage,
]);
export type HubToPhone = z.infer<typeof HubToPhone>;

/**
 * The hub closes a phone socket with this code when its pairing ends; the phone must forget its owner token.
 * Close reason (exact string): `glasses_restarted` = the glasses powered on again (every boot starts unpaired),
 * `unpaired` = Unpair from another phone, or this owner token was used to pair other glasses.
 */
export const PHONE_CLOSE_UNPAIRED = 4003;
export const UnpairReason = z.enum(["unpaired", "glasses_restarted"]);
export type UnpairReason = z.infer<typeof UnpairReason>;

/**
 * Liveness: the hub pings every socket (/device and /phone) every `pingEveryMs` and terminates one that has
 * answered none of the last `maxMissed` pings (~10 s), so a power cut shows as offline quickly.
 * Browsers and the firmware's WebSocket library answer pings automatically.
 */
export const HEARTBEAT = { pingEveryMs: 5_000, maxMissed: 2 } as const;

// ---------------------------------------------------------------- device <-> hub (/device), firmware side

/**
 * Device auth (challenge-response, trust on first use):
 *   hub    -> device  {t:"challenge", nonce}                    nonce = 32 random bytes, hex
 *   device -> hub     {t:"auth", unitId, fw, mac, boot, fresh}  mac: see below
 *   hub    -> device  {t:"auth_ok", paired}  then `pair_code` if unpaired, else the last `oled`
 *
 * Pairing lasts one power-on: EVERY power-on shows a fresh pairing code.
 * `fresh` = true on every auth attempt of this power-on until the first `auth_ok` arrives, false on every
 * reconnect after that (Wi-Fi drop, hub restart). The firmware keeps it in RAM only, so a reset starts true.
 *   fresh true    -> the glasses just powered on: clear owner_token_hash, close paired phones
 *                    (PHONE_CLOSE_UNPAIRED, "glasses_restarted"), show a fresh pairing code. Always, even when
 *                    the hub restarted and remembers no boot id. If that database write fails the hub closes
 *                    the socket (1013 "store unavailable") without `auth_ok`, so the device retries, still fresh.
 * `fresh` false or absent (older firmware) -> compare `boot` = 16 random bytes (hex) the firmware draws once per
 * boot (esp_random) and re-sends on every reconnect within that boot. The hub remembers the last boot id per
 * unit IN MEMORY only:
 *   same boot id  -> a Wi-Fi/hub reconnect: keep the pairing
 *   new boot id   -> the glasses restarted: unpair as above
 *   none remembered (the hub itself restarted) or `boot` absent -> keep the stored pairing
 * The boot id is random per boot, never stored in the database and never logged.
 * First contact for a unitId stores sha256(unit_secret)... the hub can't learn the secret from a MAC, so the
 * device sends `secret` ONCE in `register` when the hub answers `{t:"register"}` (unknown unit).
 *
 * MAC KEY (exact; firmware must match): the hub stores only unit_secret_hash, so the HMAC is keyed by it:
 *   secret_bytes = hexdecode(unit_secret)                       (32 bytes, the same hex sent in `register`)
 *   key          = SHA-256(secret_bytes)                        (32 raw bytes; hub stores hex(key) as unit_secret_hash)
 *   mac          = hex(HMAC-SHA256(key, utf8("cpay/v1/device-auth:" + nonce)))   nonce = the 64 lowercase hex chars
 * After `register` the device sends nothing more: the hub replies `auth_ok` directly.
 * Binary messages from the device are JPEG frames (must start with FF D8, <= LIMITS.frameMaxBytes).
 */
export const UnitId = z.string().regex(/^[a-z0-9-]{4,40}$/);
/** 16 random bytes, 32 lowercase hex chars, new on every boot of the glasses. */
export const BootId = z.string().regex(/^[0-9a-f]{32}$/);
export const DeviceChallenge = z.object({ t: z.literal("challenge"), nonce: z.string().regex(/^[0-9a-f]{64}$/) });
export const DeviceAuthOk = z.object({ t: z.literal("auth_ok"), paired: z.boolean() });
export const DeviceRegisterRequest = z.object({ t: z.literal("register") });
export const DevicePairCode = z.object({ t: z.literal("pair_code"), code: PairingCode, exp: z.number().int() });
export const DevicePaired = z.object({ t: z.literal("paired") });
export const DeviceOled = z.object({ t: z.literal("oled"), lines: OledLines });
export const DeviceStream = z.object({
  t: z.literal("stream"),
  on: z.boolean(),
  fps: z.number().int().min(1).max(10).default(5),
  size: z.literal("QVGA").default("QVGA"),
});
export const HubToDevice = z.discriminatedUnion("t", [
  DeviceChallenge,
  DeviceAuthOk,
  DeviceRegisterRequest,
  DevicePairCode,
  DevicePaired,
  DeviceOled,
  DeviceStream,
]);
export type HubToDevice = z.infer<typeof HubToDevice>;

export const DeviceAuth = z.object({
  t: z.literal("auth"),
  unitId: UnitId,
  fw: z.string().max(32),
  mac: z.string().regex(/^[0-9a-f]{64}$/),
  /** Per-boot random id (see "Pairing lasts one power-on" above). Optional only for older firmware. */
  boot: BootId.optional(),
  /** True until the first `auth_ok` of this power-on (see "Pairing lasts one power-on" above). Optional only for older firmware. */
  fresh: z.boolean().optional(),
});
/** Only after the hub sent `register` (unknown unit). 32 bytes hex. */
export const DeviceRegister = z.object({ t: z.literal("register"), unitId: UnitId, secret: z.string().regex(/^[0-9a-f]{64}$/) });
export const DeviceStatus = z.object({
  t: z.literal("status"),
  rssi: z.number().int(),
  heap: z.number().int().nonnegative(),
  fps: z.number().nonnegative(),
});
export const DeviceToHub = z.discriminatedUnion("t", [DeviceAuth, DeviceRegister, DeviceStatus]);
export type DeviceToHub = z.infer<typeof DeviceToHub>;

export const DEVICE_AUTH_PREFIX = "cpay/v1/device-auth:";

// ---------------------------------------------------------------- OLED screens (phone uses these)

const short = (addr: string) => `${addr.slice(0, 6)}..${addr.slice(-4)}`;
const fmt = (amount: string, token: string) => `${amount} ${token}`.slice(0, OLED_MAX_CHARS);

/** Every screen the phone pushes. Local firmware screens (BOOTING, WIFI SETUP, NO WIFI, NO HUB) aren't here. */
export const oledStates = {
  ready: () => ["READY", "TAP SCAN ON PHONE"],
  scanning: () => ["SCANNING..."],
  noQr: () => ["NO QR", "TAP TO RETRY"],
  notWalletQr: () => ["NOT A WALLET QR", "TAP TO RETRY"],
  wrongNetwork: () => ["WRONG NETWORK", "TAP TO RETRY"],
  verifiedHuman: () => ["VERIFIED HUMAN", "SAY AMOUNT"],
  publicAddr: (to: string) => ["PUBLIC ADDR", short(to), "SAY AMOUNT"],
  sayAmountAgain: () => ["SAY AMOUNT AGAIN"],
  confirm: (amount: string, token: string, code: number) => [`PAY ${fmt(amount, token)}`.slice(0, OLED_MAX_CHARS), `SAY CONFIRM ${code}`],
  confirmAgain: (code: number) => ["SAY AGAIN:", `CONFIRM ${code}`],
  noVerifiedRecipient: () => ["NO VERIFIED", "RECIPIENT"],
  approveOnPhone: () => ["APPROVE ON PHONE"],
  paying: () => ["PAYING..."],
  paid: (amount: string, token: string) => ["PAID", fmt(amount, token)],
  cancelled: () => ["CANCELLED"],
  brainOffline: () => ["BRAIN OFFLINE", "PAUSED"],
} satisfies Record<string, (...args: never[]) => string[]>;

/** Validate before sending; throws on anything the OLED can't show. */
export function oled(lines: string[]): OledLines {
  return OledLines.parse(lines);
}
