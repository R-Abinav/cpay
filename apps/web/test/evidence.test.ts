import { describe, expect, it } from "vitest";
import { mergeEvidence } from "../app/pay/run-view.js";
import type { EvidenceRecord } from "../lib/api.js";
import { isNotImplemented } from "../lib/deps.js";

const ev = (kind: string, requestId: string | null, ts = "t"): EvidenceRecord => ({
  ts,
  kind,
  model: "m",
  trustMode: "private",
  httpStatus: 200,
  requestId,
  receipt: null,
  rawTrace: null,
  rawZgHeaders: {},
});

describe("0G evidence in the UI is never dropped", () => {
  it("takes the server's cumulative list when it is a superset", () => {
    const a = [ev("transcribe", "r1")];
    const b = [ev("transcribe", "r1"), ev("intent", "r2")];
    expect(mergeEvidence(a, b)).toBe(b);
  });

  it("keeps records the incoming list doesn't have", () => {
    const cur = [ev("transcribe", "r1"), ev("intent", "r2")];
    const out = mergeEvidence(cur, [ev("speak", "r3", "t2")]);
    expect(out.map((e) => e.requestId)).toEqual(["r1", "r2", "r3"]);
  });

  it("keeps failed calls without a request id", () => {
    const cur = [ev("transcribe", "r1")];
    expect(mergeEvidence(cur, undefined)).toBe(cur);
    expect(mergeEvidence(cur, [ev("transcribe", "r1"), ev("intent", null)])).toHaveLength(2);
  });
});

describe("stub detection", () => {
  it("recognises the workspace stubs' error", () => {
    expect(isNotImplemented(new Error("not implemented"))).toBe(true);
    expect(isNotImplemented(new Error("network down"))).toBe(false);
    expect(isNotImplemented("not implemented")).toBe(false);
  });
});
