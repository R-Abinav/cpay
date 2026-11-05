import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractReceipt,
  extractRequestId,
  formatEvidenceLine,
  pickZgHeaders,
  recordEvidence,
  type Evidence,
} from "../src/index.js";

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  ts: "2026-11-05T00:00:00.000Z",
  kind: "intent",
  model: "glm-5.3",
  trustMode: "private",
  httpStatus: 200,
  requestId: "req_1",
  clientRequestId: "cid_1",
  receipt: { resKey: "chat-key-1", teeVerified: true, provider: "0xP", providerIdentity: null },
  rawTrace: { request_id: "req_1", tee_verified: true },
  rawZgHeaders: { "x-request-id": "req_1" },
  latencyMs: 12,
  ...over,
});

describe("request ID extraction", () => {
  it("prefers the X-Request-ID header", () => {
    const h = new Headers({ "X-Request-ID": "req_header" });
    expect(extractRequestId(h, {})).toBe("req_header");
    expect(extractRequestId(h, { x_0g_trace: { request_id: "req_body" } })).toBe("req_body");
    // live router: two values, the second equals x_0g_trace.request_id
    expect(extractRequestId(new Headers({ "x-request-id": "895eecec18dc89af, aac68a56-f6bb" }), null)).toBe("aac68a56-f6bb");
  });

  it("falls back to x_0g_trace.request_id", () => {
    expect(extractRequestId(new Headers(), { x_0g_trace: { request_id: "req_body" } })).toBe("req_body");
  });

  it("falls back to an error body's top-level request_id", () => {
    expect(extractRequestId(new Headers(), { error: { code: "x" }, request_id: "req_err" })).toBe("req_err");
  });

  it("returns null when there is none", () => {
    expect(extractRequestId(new Headers(), { x_0g_trace: {} })).toBeNull();
    expect(extractRequestId(new Headers({ "x-request-id": "  " }), null)).toBeNull();
  });
});

describe("raw header capture + receipt", () => {
  it("keeps every x-0g-* / zg-* header verbatim plus request/provider ids, drops the rest", () => {
    const h = new Headers({
      "X-0g-E2ee": "none",
      "X-0g-Gateway-Instance": "3dab",
      "ZG-Res-Key": "chat-key-1",
      "X-Request-Id": "req_1",
      "X-Provider": "0xP",
      "X-Client-Request-Id": "cid",
      "Content-Type": "application/json",
      "Set-Cookie": "nope=1",
    });
    expect(pickZgHeaders(h)).toEqual({
      "x-0g-e2ee": "none",
      "x-0g-gateway-instance": "3dab",
      "zg-res-key": "chat-key-1",
      "x-request-id": "req_1",
      "x-provider": "0xP",
      "x-client-request-id": "cid",
    });
  });

  it("builds the receipt from ZG-Res-Key and x_0g_trace", () => {
    const h = new Headers({ "ZG-Res-Key": "chat-key-1" });
    const body = { x_0g_trace: { request_id: "r", provider: "0xP", provider_identity: "baidu", tee_verified: false } };
    expect(extractReceipt(h, body)).toEqual({ resKey: "chat-key-1", teeVerified: false, provider: "0xP", providerIdentity: "baidu" });
  });

  it("is null when 0G sent no receipt fields", () => {
    expect(extractReceipt(new Headers(), { x_0g_trace: { request_id: "r" } })).toBeNull();
  });
});

describe("recordEvidence", () => {
  it("prints one line with IDs and receipt status", () => {
    expect(formatEvidenceLine(ev())).toBe(
      "[0g] kind=intent model=glm-5.3 trust=private status=200 requestId=req_1 receipt=chat-key-1 tee_verified=true provider=0xP clientRequestId=cid_1",
    );
    expect(formatEvidenceLine(ev({ requestId: null, receipt: null, httpStatus: null, error: "timeout" }))).toBe(
      "[0g] kind=intent model=glm-5.3 trust=private status=none requestId=missing receipt=missing tee_verified=absent clientRequestId=cid_1 error=timeout",
    );
  });

  it("prints the storage index line", () => {
    const line = formatEvidenceLine(
      ev({ kind: "storage", model: "0g-storage", rootHash: "0xroot", txHash: "0xtx", requestIds: ["a", "b"] }),
    );
    expect(line).toBe("[0g] kind=storage model=0g-storage rootHash=0xroot txHash=0xtx requestIds=a,b");
  });

  it("appends JSONL (creating parent dirs) and logs exactly one line per record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zg-ev-"));
    const path = join(dir, "nested", "evidence.jsonl");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordEvidence(ev(), path);
    await recordEvidence(ev({ requestId: "req_2" }), path);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.requestId)).toEqual(["req_1", "req_2"]);
    expect(lines[0].rawTrace).toEqual({ request_id: "req_1", tee_verified: true });
  });
});
