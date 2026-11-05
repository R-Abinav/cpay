/**
 * Wire messages for the glasses bridge.
 *
 * Browser-safe: imports only zod, so the web app can `import { ... } from "@cpay/glasses-kit"`.
 *
 *   web app (/pay)  <── ws://localhost:BRIDGE_WS_PORT (JSON) ──>  bridge  <── ws://<mac>:BRIDGE_HTTP_PORT ──>  C3 / CAM
 *
 * Web-app side: `WebToBridge` (what the web app sends) and `BridgeToWeb` (what it receives).
 * Device side (firmware <-> bridge, internal): `C3ToBridge`, `CamToBridge`, `BridgeToC3`, `BridgeToCam`.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------- shared pieces

export const ButtonEvent = z.enum(["capture_down", "capture_up", "confirm", "cancel"]);
export type ButtonEvent = z.infer<typeof ButtonEvent>;

/** 128x64 OLED: up to 6 lines of up to 21 printable ASCII characters. The firmware picks a big
 * font automatically when there are <= 3 lines of <= 12 characters each. */
export const OLED_MAX_LINES = 6;
export const OLED_MAX_CHARS = 21;
export const OledLine = z
  .string()
  .max(OLED_MAX_CHARS)
  .regex(/^[\x20-\x7E]*$/, "printable ASCII only");
export const OledLines = z.array(OledLine).min(1).max(OLED_MAX_LINES);

export const DeviceStatus = z.object({ c3: z.boolean(), cam: z.boolean() });
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const FrameErrorReason = z.enum([
  "cam_offline", // no CAM connected to the bridge
  "busy", // a capture is already in flight
  "timeout", // CAM didn't answer in time
  "camera_error", // CAM reported a failure (see detail)
  "bad_frame", // CAM sent something that isn't a JPEG
]);
export type FrameErrorReason = z.infer<typeof FrameErrorReason>;

// ---------------------------------------------------------------- web app -> bridge

/** Show text on the glasses OLED. Last write wins; the bridge replays it when the C3 reconnects. */
export const OledMessage = z.object({ type: z.literal("oled"), lines: OledLines });
export type OledMessage = z.infer<typeof OledMessage>;

/** Ask for a frame without a button press (e.g. a retry button in the UI). */
export const CaptureRequestMessage = z.object({ type: z.literal("capture_request") });
export type CaptureRequestMessage = z.infer<typeof CaptureRequestMessage>;

export const WebToBridge = z.discriminatedUnion("type", [OledMessage, CaptureRequestMessage]);
export type WebToBridge = z.infer<typeof WebToBridge>;

// ---------------------------------------------------------------- bridge -> web app

/** Sent once right after the web app connects. */
export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  devices: DeviceStatus,
});

/** Sent whenever the C3 or CAM connects or disconnects. */
export const DeviceStatusMessage = z.object({
  type: z.literal("device_status"),
  devices: DeviceStatus,
});

/** A physical button on the glasses. `capture_down`/`capture_up` bracket push-to-talk. */
export const ButtonMessage = z.object({
  type: z.literal("button"),
  event: ButtonEvent,
  ts: z.number().int(), // bridge receive time, ms since epoch
});

/** One JPEG from the glasses camera (~640x480). The bridge keeps no copy. */
export const FrameMessage = z.object({
  type: z.literal("frame"),
  id: z.number().int().nonnegative(),
  mime: z.literal("image/jpeg"),
  bytes: z.number().int().positive(),
  dataBase64: z.string().min(1),
  ts: z.number().int(),
});

export const FrameErrorMessage = z.object({
  type: z.literal("frame_error"),
  id: z.number().int().nonnegative().nullable(),
  reason: FrameErrorReason,
  detail: z.string().optional(),
});

/** The bridge rejected something the web app sent. */
export const ErrorMessage = z.object({ type: z.literal("error"), reason: z.string() });

export const BridgeToWeb = z.discriminatedUnion("type", [
  HelloMessage,
  DeviceStatusMessage,
  ButtonMessage,
  FrameMessage,
  FrameErrorMessage,
  ErrorMessage,
]);
export type BridgeToWeb = z.infer<typeof BridgeToWeb>;
export type HelloMessage = z.infer<typeof HelloMessage>;
export type DeviceStatusMessage = z.infer<typeof DeviceStatusMessage>;
export type ButtonMessage = z.infer<typeof ButtonMessage>;
export type FrameMessage = z.infer<typeof FrameMessage>;
export type FrameErrorMessage = z.infer<typeof FrameErrorMessage>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;

// ---------------------------------------------------------------- OLED states (docs/HARDWARE.md)

const amountText = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, "decimal amount");
const tokenText = z.string().regex(/^[A-Z0-9]{1,8}$/, "token symbol");

/** The fixed OLED states. Use these instead of free text so the glasses always show known screens. */
export const oledStates = {
  ready: (): OledMessage => ({ type: "oled", lines: ["READY"] }),
  listening: (): OledMessage => ({ type: "oled", lines: ["LISTENING"] }),
  verified: (amount: string, token: string): OledMessage => ({
    type: "oled",
    lines: ["VERIFIED HUMAN", `${amountText.parse(amount)} ${tokenText.parse(token)}`, "OK?"],
  }),
  noVerifiedRecipient: (): OledMessage => ({ type: "oled", lines: ["NO VERIFIED", "RECIPIENT"] }),
  paid: (): OledMessage => ({ type: "oled", lines: ["PAID"] }),
  cancelled: (): OledMessage => ({ type: "oled", lines: ["CANCELLED"] }),
  approveOnPhone: (): OledMessage => ({ type: "oled", lines: ["APPROVE ON", "PHONE"] }),
  brainOffline: (): OledMessage => ({ type: "oled", lines: ["BRAIN OFFLINE", "PAUSED"] }),
} as const;

/** What the bridge shows when no web app is connected. */
export const NO_APP_LINES: readonly string[] = ["NO APP"];

// ---------------------------------------------------------------- device side (firmware <-> bridge)

const fw = z.string().max(32);

export const C3ToBridge = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), role: z.literal("c3"), fw }),
  z.object({ t: z.literal("btn"), e: ButtonEvent }),
]);
export type C3ToBridge = z.infer<typeof C3ToBridge>;

/** CAM text messages. Frames arrive as binary: 4-byte big-endian capture id + JPEG bytes. */
export const CamToBridge = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    role: z.literal("cam"),
    fw,
    map: z.string().max(32).optional(),
    camera: z.boolean().optional(),
    psram: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("capture_error"),
    id: z.number().int().nonnegative(),
    reason: z.string().max(64),
  }),
]);
export type CamToBridge = z.infer<typeof CamToBridge>;

export const BridgeToC3 = z.object({ t: z.literal("oled"), lines: OledLines });
export type BridgeToC3 = z.infer<typeof BridgeToC3>;

export const BridgeToCam = z.object({ t: z.literal("capture"), id: z.number().int().nonnegative() });
export type BridgeToCam = z.infer<typeof BridgeToCam>;

/** Parse a JSON string against a schema; returns null instead of throwing. */
export function parseJson<T>(schema: z.ZodType<T>, raw: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

/** Split a CAM binary frame into its capture id and JPEG bytes. Null if malformed. */
export function decodeCamFrame(buf: Uint8Array): { id: number; jpeg: Uint8Array } | null {
  if (buf.length < 4 + 4) return null;
  const id = ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
  const jpeg = buf.subarray(4);
  // JPEG SOI marker
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  return { id, jpeg };
}
