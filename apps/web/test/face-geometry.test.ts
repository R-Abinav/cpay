import { describe, expect, it } from "vitest";
import {
  ALIGN_TEMPLATE_112,
  DETECTOR_SIZE,
  applyAffine,
  decodeYunet,
  estimateSimilarity,
  letterboxScale,
  nms,
  pickFace,
  rgbaToChw,
  type Face,
  type Point,
} from "../lib/face/geometry.js";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("estimateSimilarity", () => {
  it("recovers a known scale + rotation + translation", () => {
    const s = 1.7, th = 0.3, tx = 12, ty = -5;
    const src: Point[] = [[10, 20], [50, 22], [30, 40], [15, 60], [45, 61]];
    const dst = src.map(([x, y]) => [s * Math.cos(th) * x - s * Math.sin(th) * y + tx, s * Math.sin(th) * x + s * Math.cos(th) * y + ty] as Point);
    const t = estimateSimilarity(src, dst);
    src.forEach((p, i) => {
      const q = applyAffine(t, p);
      close(q[0], dst[i]![0]);
      close(q[1], dst[i]![1]);
    });
  });

  it("maps template onto itself as identity", () => {
    const t = estimateSimilarity(ALIGN_TEMPLATE_112, ALIGN_TEMPLATE_112);
    close(t.a, 1); close(t.b, 0); close(t.e, 0); close(t.f, 0);
  });

  it("rejects degenerate input", () => {
    expect(() => estimateSimilarity([[1, 1], [1, 1]], [[0, 0], [1, 1]])).toThrow();
    expect(() => estimateSimilarity([[1, 1]], [[0, 0]])).toThrow();
  });
});

describe("decodeYunet", () => {
  function emptyOutputs() {
    const out: Record<string, Float32Array> = {};
    for (const s of [8, 16, 32]) {
      const n = (DETECTOR_SIZE / s) ** 2;
      out[`cls_${s}`] = new Float32Array(n);
      out[`obj_${s}`] = new Float32Array(n);
      out[`bbox_${s}`] = new Float32Array(n * 4);
      out[`kps_${s}`] = new Float32Array(n * 10);
    }
    return out;
  }

  it("decodes one anchor into source pixels and drops low scores", () => {
    const out = emptyOutputs();
    const cols = DETECTOR_SIZE / 32;
    const i = 3 * cols + 5; // row 3, col 5 at stride 32
    out.cls_32![i] = 1;
    out.obj_32![i] = 0.81; // score = 0.9
    out.bbox_32!.set([0.5, 0.5, Math.log(2), Math.log(3)], i * 4);
    out.kps_32!.set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], i * 10);
    const scale = 0.5;
    const faces = decodeYunet(out, scale);
    expect(faces).toHaveLength(1);
    const f = faces[0]!;
    close(f.score, 0.9);
    // cx = (5 + .5) * 32 = 176, w = 64 -> x1 = 144, then / scale
    close(f.box[0], 288, 1e-3); close(f.box[1], ((3.5 * 32) - 48) / scale, 1e-3); close(f.box[2], 128, 1e-3); close(f.box[3], 192, 1e-3);
    expect(f.landmarks[0]).toEqual([(5 * 32) / scale, (3 * 32) / scale]);
  });

  it("throws if an output is missing", () => {
    const out = emptyOutputs();
    delete out.kps_16;
    expect(() => decodeYunet(out, 1)).toThrow(/stride 16/);
  });
});

const face = (x: number, y: number, w: number, h: number, score = 0.9): Face => ({ box: [x, y, w, h], landmarks: [], score });

describe("nms + pickFace", () => {
  it("suppresses overlapping lower-score boxes", () => {
    const kept = nms([face(0, 0, 10, 10, 0.8), face(1, 1, 10, 10, 0.95), face(50, 50, 10, 10, 0.7)]);
    expect(kept.map((f) => f.score)).toEqual([0.95, 0.7]);
  });

  it("picks largest for enrolment and nearest-centre for the glasses", () => {
    const faces = [face(0, 0, 100, 100), face(300, 220, 40, 40)];
    expect(pickFace(faces, "largest", 640, 480)).toBe(faces[0]);
    expect(pickFace(faces, "centre", 640, 480)).toBe(faces[1]);
    expect(pickFace([], "centre", 640, 480)).toBeNull();
  });
});

describe("letterbox + CHW", () => {
  it("fits the long side", () => {
    expect(letterboxScale(1280, 720)).toBe(0.5);
    expect(letterboxScale(320, 640)).toBe(1);
  });

  it("splits RGBA into planes in the requested order", () => {
    const rgba = [1, 2, 3, 255, 4, 5, 6, 255];
    expect(Array.from(rgbaToChw(rgba, 2, 1, "rgb"))).toEqual([1, 4, 2, 5, 3, 6]);
    expect(Array.from(rgbaToChw(rgba, 2, 1, "bgr"))).toEqual([3, 6, 2, 5, 1, 4]);
    expect(() => rgbaToChw(rgba, 3, 1, "rgb")).toThrow();
  });
});
