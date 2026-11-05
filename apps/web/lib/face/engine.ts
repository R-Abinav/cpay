"use client";
// Browser face engine: onnxruntime-web (self-hosted under /ort) + YuNet + SFace (self-hosted under /models).
// The same code embeds the enrolment selfies on the phone and the glasses frame on the laptop.
import type * as Ort from "onnxruntime-web";
import {
  DETECTOR_SIZE,
  EMBED_SIZE,
  alignmentFor,
  decodeYunet,
  letterboxScale,
  pickFace,
  rgbaToChw,
  type Face,
} from "./geometry.js";

export const FACE_MODEL_ID = "sface-2021dec-int8+yunet-2023mar";
export const DETECTOR_URL = "/models/face_detection_yunet_2023mar.onnx";
export const EMBEDDER_URL = "/models/face_recognition_sface_2021dec_int8.onnx";
const ORT_SCRIPT = "/ort/ort.wasm.min.js";

type OrtModule = typeof Ort;
declare global {
  interface Window {
    ort?: OrtModule;
  }
}

let ortPromise: Promise<OrtModule> | null = null;
function loadOrt(): Promise<OrtModule> {
  if (ortPromise) return ortPromise;
  ortPromise = new Promise<OrtModule>((resolve, reject) => {
    if (window.ort) return resolve(window.ort);
    const s = document.createElement("script");
    s.src = ORT_SCRIPT;
    s.async = true;
    s.onload = () => (window.ort ? resolve(window.ort) : reject(new Error("onnxruntime-web did not load")));
    s.onerror = () => reject(new Error(`could not load ${ORT_SCRIPT} (run scripts/copy-ort.mjs)`));
    document.head.appendChild(s);
  }).then((ort) => {
    ort.env.wasm.wasmPaths = "/ort/";
    // Single-threaded: no SharedArrayBuffer / cross-origin isolation needed on phones.
    ort.env.wasm.numThreads = 1;
    return ort;
  });
  ortPromise.catch(() => {
    ortPromise = null;
  });
  return ortPromise;
}

interface Engine {
  ort: OrtModule;
  detector: Ort.InferenceSession;
  embedder: Ort.InferenceSession;
}
let enginePromise: Promise<Engine> | null = null;

/** Load runtime + both models once. Rejects with a readable error if a file is missing. */
export function loadFaceEngine(): Promise<Engine> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const ort = await loadOrt();
    const [detector, embedder] = await Promise.all([
      ort.InferenceSession.create(DETECTOR_URL, { executionProviders: ["wasm"] }),
      ort.InferenceSession.create(EMBEDDER_URL, { executionProviders: ["wasm"] }),
    ]);
    return { ort, detector, embedder };
  })();
  enginePromise.catch(() => {
    enginePromise = null;
  });
  return enginePromise;
}

export interface EmbedResult {
  embedding: Float32Array;
  face: Face;
  faces: number;
}

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

/**
 * Detect, pick ("largest" for selfies, "centre" for the glasses), align and embed one face.
 * Returns null when no face is found. The source pixels live only in temporary canvases.
 */
export async function embedFace(
  source: CanvasImageSource,
  width: number,
  height: number,
  mode: "largest" | "centre",
): Promise<EmbedResult | null> {
  const { ort, detector, embedder } = await loadFaceEngine();

  const scale = letterboxScale(width, height);
  const det = canvas(DETECTOR_SIZE, DETECTOR_SIZE);
  det.fillStyle = "#000";
  det.fillRect(0, 0, DETECTOR_SIZE, DETECTOR_SIZE);
  det.drawImage(source, 0, 0, width * scale, height * scale);
  const detPixels = det.getImageData(0, 0, DETECTOR_SIZE, DETECTOR_SIZE).data;
  const detIn = new ort.Tensor("float32", rgbaToChw(detPixels, DETECTOR_SIZE, DETECTOR_SIZE, "bgr"), [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]);
  const detOut = await detector.run({ [detector.inputNames[0]!]: detIn });
  const outputs: Record<string, ArrayLike<number>> = {};
  for (const name of detector.outputNames) outputs[name] = detOut[name]!.data as Float32Array;
  const faces = decodeYunet(outputs, scale);
  const face = pickFace(faces, mode, width, height);
  if (!face) return null;

  const t = alignmentFor(face);
  const al = canvas(EMBED_SIZE, EMBED_SIZE);
  al.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
  al.drawImage(source, 0, 0, width, height);
  al.setTransform(1, 0, 0, 1, 0, 0);
  const pixels = al.getImageData(0, 0, EMBED_SIZE, EMBED_SIZE).data;
  const embIn = new ort.Tensor("float32", rgbaToChw(pixels, EMBED_SIZE, EMBED_SIZE, "rgb"), [1, 3, EMBED_SIZE, EMBED_SIZE]);
  const embOut = await embedder.run({ [embedder.inputNames[0]!]: embIn });
  const embedding = Float32Array.from(embOut[embedder.outputNames[0]!]!.data as Float32Array);
  return { embedding, face, faces: faces.length };
}

/** Decode a JPEG (e.g. a glasses frame) into an ImageBitmap. Caller must close() it. */
export async function decodeJpeg(base64: string): Promise<ImageBitmap> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
}
