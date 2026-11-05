// Local face matching. Cosine similarity against an L2-normalised mean template.

export const DEFAULT_MATCH_THRESHOLD = 0.6;
export const MIN_ENROLMENT_EMBEDDINGS = 5;

type Vec = ArrayLike<number>;

function assertFinite(v: Vec, name: string): void {
  if (v.length === 0) throw new Error(`${name}: empty embedding`);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) throw new Error(`${name}: non-finite value`);
  }
}

function norm(v: Vec): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] as number) ** 2;
  return Math.sqrt(s);
}

export function l2Normalize(v: Vec): Float32Array {
  assertFinite(v, "l2Normalize");
  const n = norm(v);
  if (n === 0) throw new Error("l2Normalize: zero vector");
  return Float32Array.from(v, (x) => x / n);
}

/** Cosine similarity. Throws on a length mismatch, empty, zero or non-finite input. */
export function cosine(a: Vec, b: Vec): number {
  if (a.length !== b.length) throw new Error(`cosine: length mismatch (${a.length} vs ${b.length})`);
  assertFinite(a, "cosine");
  assertFinite(b, "cosine");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  const d = norm(a) * norm(b);
  if (d === 0) throw new Error("cosine: zero vector");
  return dot / d;
}

/** Template = L2-normalised mean of >= minCount L2-normalised enrolment embeddings of equal length. */
export function buildTemplate(embeddings: readonly Vec[], minCount = MIN_ENROLMENT_EMBEDDINGS): Float32Array {
  if (embeddings.length < minCount) throw new Error(`buildTemplate: need at least ${minCount} embeddings`);
  const dim = embeddings[0]!.length;
  const sum = new Float64Array(dim);
  for (const e of embeddings) {
    if (e.length !== dim) throw new Error("buildTemplate: embedding length mismatch");
    const n = l2Normalize(e);
    for (let i = 0; i < dim; i++) sum[i]! += n[i]!;
  }
  return l2Normalize(sum);
}

/** True only when lengths match and cosine >= threshold. A length mismatch never matches. */
export function isMatch(probe: Vec, template: Vec, threshold = DEFAULT_MATCH_THRESHOLD): boolean {
  if (probe.length !== template.length) return false;
  try {
    return cosine(probe, template) >= threshold;
  } catch {
    return false;
  }
}
