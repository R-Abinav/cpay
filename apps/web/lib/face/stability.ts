// Payer side, pure: decide when the glasses see ONE centred, steady face worth embedding.
// Only boxes are tracked here (no pixels, no embeddings), and only for the current scan.
import { iou, type Face } from "./geometry.js";

export const FACE_GATE = {
  /** Consecutive frames the same centred face must be seen. */
  stableFrames: 3,
  /** Box overlap between consecutive frames to count as "the same, steady" face. */
  minIou: 0.5,
  /** Face centre must lie within this fraction of the frame around its centre (0.5 = middle half). */
  centreBand: 0.5,
  /** Face box width must be at least this fraction of the frame width (too far away = unreliable). */
  minWidthFrac: 0.12,
} as const;

export type FaceGateState = { box: Face["box"] | null; streak: number };
export const faceGateInit: FaceGateState = { box: null, streak: 0 };

export type FaceVerdict = "none" | "off_centre" | "too_small" | "crowd" | "steadying" | "stable";

/** Is this face inside the centre band and big enough? */
export function centred(face: Face, width: number, height: number, cfg = FACE_GATE): "ok" | "off_centre" | "too_small" {
  const [x, y, w, h] = face.box;
  if (w < cfg.minWidthFrac * width) return "too_small";
  const cx = x + w / 2;
  const cy = y + h / 2;
  const half = cfg.centreBand / 2;
  if (Math.abs(cx / width - 0.5) > half || Math.abs(cy / height - 0.5) > half) return "off_centre";
  return "ok";
}

/**
 * One step per analysed frame. `faces` = every face found; `picked` = the one nearest the centre.
 * More than one face inside the centre band is a "crowd": never guess who the wearer means.
 */
export function faceGateStep(
  st: FaceGateState,
  faces: readonly Face[],
  picked: Face | null,
  width: number,
  height: number,
  cfg = FACE_GATE,
): [FaceGateState, FaceVerdict] {
  if (!picked) return [faceGateInit, "none"];
  const inBand = faces.filter((f) => centred(f, width, height, cfg) !== "off_centre");
  if (inBand.length > 1) return [faceGateInit, "crowd"];
  const c = centred(picked, width, height, cfg);
  if (c !== "ok") return [faceGateInit, c];
  const same = st.box !== null && iou(st.box, picked.box) >= cfg.minIou;
  const streak = same ? st.streak + 1 : 1;
  const next = { box: picked.box, streak };
  return [next, streak >= cfg.stableFrames ? "stable" : "steadying"];
}
