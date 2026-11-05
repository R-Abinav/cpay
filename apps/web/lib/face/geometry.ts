// Pure face preprocessing shared by /receive (phone) and /pay (laptop). No DOM, no model: unit-tested.
// Pipeline (both sides, identical): frame -> letterbox to 640x640 (BGR, 0-255) -> YuNet -> decode + NMS
// -> pick a face -> similarity transform of its 5 landmarks onto the ArcFace 112x112 template
// -> 112x112 RGB 0-255 CHW -> SFace -> 128-d embedding.

export const DETECTOR_SIZE = 640;
export const EMBED_SIZE = 112;
export const DETECTOR_STRIDES = [8, 16, 32] as const;
export const DEFAULT_SCORE_THRESHOLD = 0.6;
export const DEFAULT_NMS_IOU = 0.3;

export type Point = [number, number];

/** Standard 5-point template for 112x112 aligned faces (eyes, nose, mouth corners; image-left first). */
export const ALIGN_TEMPLATE_112: readonly Point[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export interface Face {
  /** x, y, w, h in source-image pixels */
  box: [number, number, number, number];
  /** 5 landmarks in source-image pixels: right eye, left eye, nose, right mouth, left mouth (image-left first) */
  landmarks: Point[];
  score: number;
}

/** Scale used to letterbox a w x h frame into the detector square (top-left aligned, zero padded). */
export function letterboxScale(width: number, height: number, size = DETECTOR_SIZE): number {
  if (width <= 0 || height <= 0) throw new Error("letterbox: empty frame");
  return Math.min(size / width, size / height);
}

/** Raw YuNet outputs by name: cls_8.., obj_8.., bbox_8.., kps_8.. (flat Float32Arrays). */
export type YunetOutputs = Record<string, ArrayLike<number>>;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Decode YuNet (2023mar) outputs as OpenCV's FaceDetectorYN does, then map back to source pixels
 * by dividing by the letterbox scale.
 */
export function decodeYunet(
  out: YunetOutputs,
  scale: number,
  opts: { size?: number; scoreThreshold?: number } = {},
): Face[] {
  const size = opts.size ?? DETECTOR_SIZE;
  const thr = opts.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const faces: Face[] = [];
  for (const stride of DETECTOR_STRIDES) {
    const cls = out[`cls_${stride}`];
    const obj = out[`obj_${stride}`];
    const bbox = out[`bbox_${stride}`];
    const kps = out[`kps_${stride}`];
    if (!cls || !obj || !bbox || !kps) throw new Error(`yunet: missing outputs for stride ${stride}`);
    const cols = Math.floor(size / stride);
    const rows = Math.floor(size / stride);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
        if (score < thr) continue;
        const cx = (c + bbox[i * 4]!) * stride;
        const cy = (r + bbox[i * 4 + 1]!) * stride;
        const w = Math.exp(bbox[i * 4 + 2]!) * stride;
        const h = Math.exp(bbox[i * 4 + 3]!) * stride;
        const landmarks: Point[] = [];
        for (let n = 0; n < 5; n++) {
          landmarks.push([
            ((kps[i * 10 + 2 * n]! + c) * stride) / scale,
            ((kps[i * 10 + 2 * n + 1]! + r) * stride) / scale,
          ]);
        }
        faces.push({ box: [(cx - w / 2) / scale, (cy - h / 2) / scale, w / scale, h / scale], landmarks, score });
      }
    }
  }
  return nms(faces);
}

export function iou(a: Face["box"], b: Face["box"]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union <= 0 ? 0 : inter / union;
}

export function nms(faces: Face[], iouThreshold = DEFAULT_NMS_IOU): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: Face[] = [];
  for (const f of sorted) {
    if (keep.every((k) => iou(k.box, f.box) <= iouThreshold)) keep.push(f);
  }
  return keep;
}

/**
 * Pick the face to embed.
 * - "largest": enrolment on the phone (the owner fills the selfie frame)
 * - "centre": the payer's glasses (the person being looked at is in the middle of the frame)
 */
export function pickFace(faces: readonly Face[], mode: "largest" | "centre", width: number, height: number): Face | null {
  if (faces.length === 0) return null;
  if (mode === "largest") {
    return faces.reduce((best, f) => (f.box[2] * f.box[3] > best.box[2] * best.box[3] ? f : best));
  }
  const cx = width / 2;
  const cy = height / 2;
  const dist = (f: Face) => Math.hypot(f.box[0] + f.box[2] / 2 - cx, f.box[1] + f.box[3] / 2 - cy);
  return faces.reduce((best, f) => (dist(f) < dist(best) ? f : best));
}

/** 2D similarity transform (uniform scale + rotation + translation), as a canvas setTransform(a,b,c,d,e,f). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Least-squares similarity transform mapping `src` points onto `dst` points (Umeyama, no reflection). */
export function estimateSimilarity(src: readonly Point[], dst: readonly Point[]): Affine {
  if (src.length !== dst.length || src.length < 2) throw new Error("similarity: need >= 2 matching points");
  const n = src.length;
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i]![0]; msy += src[i]![1];
    mdx += dst[i]![0]; mdy += dst[i]![1];
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let a = 0, b = 0, v = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i]![0] - msx, sy = src[i]![1] - msy;
    const dx = dst[i]![0] - mdx, dy = dst[i]![1] - mdy;
    a += sx * dx + sy * dy;
    b += sx * dy - sy * dx;
    v += sx * sx + sy * sy;
  }
  if (v === 0) throw new Error("similarity: degenerate source points");
  const cs = a / v;
  const sn = b / v;
  return { a: cs, b: sn, c: -sn, d: cs, e: mdx - (cs * msx - sn * msy), f: mdy - (sn * msx + cs * msy) };
}

export function applyAffine(t: Affine, p: Point): Point {
  return [t.a * p[0] + t.c * p[1] + t.e, t.b * p[0] + t.d * p[1] + t.f];
}

/** Transform that warps a face's landmarks onto the 112x112 template. */
export function alignmentFor(face: Face): Affine {
  return estimateSimilarity(face.landmarks, ALIGN_TEMPLATE_112);
}

/**
 * RGBA pixels -> planar CHW float32 (0-255, no normalisation).
 * order "rgb" for SFace (OpenCV feeds it swapRB=true), "bgr" for YuNet.
 */
export function rgbaToChw(rgba: ArrayLike<number>, width: number, height: number, order: "rgb" | "bgr"): Float32Array {
  const plane = width * height;
  if (rgba.length !== plane * 4) throw new Error("rgbaToChw: size mismatch");
  const out = new Float32Array(plane * 3);
  const [c0, c2] = order === "rgb" ? [0, 2] : [2, 0];
  for (let i = 0; i < plane; i++) {
    out[i] = rgba[i * 4 + c0]!;
    out[plane + i] = rgba[i * 4 + 1]!;
    out[2 * plane + i] = rgba[i * 4 + c2]!;
  }
  return out;
}
