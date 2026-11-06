import { describe, expect, it } from "vitest";
import type { Face } from "../lib/face/geometry.js";
import { FACE_GATE, centred, faceGateInit, faceGateStep, type FaceGateState } from "../lib/face/stability.js";

const W = 640;
const H = 480;
const face = (x: number, y: number, w = 120, h = 140): Face => ({ box: [x, y, w, h], landmarks: [], score: 0.9 });
const mid = face(260, 170);

function steps(frames: Face[][]): string[] {
  let st: FaceGateState = faceGateInit;
  const out: string[] = [];
  for (const fs of frames) {
    const picked = fs[0] ?? null;
    const [n, v] = faceGateStep(st, fs, picked, W, H);
    st = n;
    out.push(v);
  }
  return out;
}

describe("face gate", () => {
  it("centred + big enough", () => {
    expect(centred(mid, W, H)).toBe("ok");
    expect(centred(face(0, 0), W, H)).toBe("off_centre");
    expect(centred(face(300, 220, 20, 24), W, H)).toBe("too_small");
  });
  it("needs N steady frames of one centred face", () => {
    const v = steps(Array.from({ length: FACE_GATE.stableFrames }, () => [mid]));
    expect(v.at(-1)).toBe("stable");
    expect(v.slice(0, -1).every((x) => x === "steadying")).toBe(true);
  });
  it("a jump resets the streak", () => {
    expect(steps([[mid], [mid], [face(200, 120)], [mid]])).toEqual(["steadying", "steadying", "steadying", "steadying"]);
  });
  it("no face resets", () => {
    expect(steps([[mid], [mid], [], [mid]]).at(-1)).toBe("steadying");
  });
  it("two faces near the centre is a crowd, never stable", () => {
    const two = [mid, face(330, 180)];
    expect(steps([two, two, two, two])).toEqual(["crowd", "crowd", "crowd", "crowd"]);
  });
  it("a second face at the edge doesn't block", () => {
    const fs = [mid, face(0, 0)];
    expect(steps([fs, fs, fs]).at(-1)).toBe("stable");
  });
});
