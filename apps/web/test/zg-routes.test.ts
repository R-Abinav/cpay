// Route-level tests for the 0G proxy routes. TEST FIXTURES ONLY: fetch is stubbed here to stand in for
// the 0G router; the demo path always calls the real router.
import { issueTicket } from "@cpay/glasses-kit/ticket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { POST: intentPOST } = await import("../app/api/intent/route.js");
const { POST: transcribePOST } = await import("../app/api/transcribe/route.js");
const { POST: speakPOST } = await import("../app/api/speak/route.js");
const { POST: episodePOST } = await import("../app/api/episode/route.js");
const { __resetRateLimitForTests } = await import("../lib/server/zg.js");
const { __setEvidenceDbForTests, toEvidenceRow } = await import("../lib/server/zg-evidence.js");
const { encryptEpisode } = await import("@cpay/zerog/browser");

const SECRET = "x".repeat(40);
const BASE_ENV = {
  ZG_ROUTER_BASE_URL: "https://router.test/v1",
  ZG_ROUTER_API_KEY: "sk-test-key",
  ZG_TRUST_MODE: "private",
  ZG_STT_MODEL: "whisper-large-v3",
  ZG_INTENT_MODEL: "intent-model",
  ZG_TTS_MODEL: "tts-model",
  ZG_TTS_VOICE: "voice-1",
  ZG_TIMEOUT_MS: "2000",
  HUB_TICKET_SECRET: SECRET,
  ZG_RATE_LIMIT_PER_MIN: "20",
  DATABASE_URL: "postgresql://fixture.invalid/db", // the fake client below is injected; nothing connects
};

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[];
let rows: Record<string, unknown>[];
let logs: string[];

function stubRouter(handler: (c: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const c: Call = { url: String(url), headers: init.headers as Record<string, string>, body: init.body instanceof FormData
          ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"]))
          : JSON.parse(String(init.body)) };
      calls.push(c);
      return handler(c);
    }),
  );
}

const zgJson = (body: unknown, status = 200, requestId = "req_1") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": requestId, "zg-res-key": "reskey_1" } });
const chat = (content: string, requestId = "req_intent") =>
  zgJson({ choices: [{ message: { content } }], x_0g_trace: { request_id: requestId, provider: "0xProv", tee_verified: true } }, 200, requestId);

const ticket = () => issueTicket(SECRET, 600).token;
const jsonReq = (path: string, body: unknown, headers: Record<string, string> = { "x-cpay-ticket": ticket() }) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const audioReq = (path: string, bytes = new Uint8Array([1, 2, 3])) => {
  const fd = new FormData();
  fd.set("audio", new Blob([bytes], { type: "audio/webm" }), "a.webm");
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "x-cpay-ticket": ticket() }, body: fd });
};

beforeEach(() => {
  calls = [];
  rows = [];
  logs = [];
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("NODE_ENV", "test");
  __resetRateLimitForTests();
  __setEvidenceDbForTests({
    zgEvidence: {
      create: async ({ data }) => {
        rows.push(data);
        return data;
      },
      findMany: async () => [],
    },
  });
  vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(l));
  vi.spyOn(console, "warn").mockImplementation((l: string) => void logs.push(l));
  vi.spyOn(console, "error").mockImplementation((l: string) => void logs.push(l));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __setEvidenceDbForTests(undefined);
});

describe("/api/intent", () => {
  it("text -> intent with real request id + receipt, one row + one log line, nothing of the text stored", async () => {
    stubRouter(() => chat('{"amount":"2","token":"USDC"}'));
    const res = await intentPOST(jsonReq("/api/intent", { text: "SECRET pay her 2 usdc" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ intent: { amount: "2", token: "USDC" }, requestIds: ["req_intent"] });
    expect(body.evidence[0]).toMatchObject({ kind: "intent", trustMode: "private", requestId: "req_intent", receiptStatus: "verified", resKey: "reskey_1" });
    expect(JSON.stringify(body)).not.toMatch(/SECRET/);
    expect(calls[0]!.headers["X-0G-Provider-Trust-Mode"]).toBe("private");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "intent", model: "intent-model", requestId: "req_intent", receiptStatus: "verified", status: "ok" });
    expect(JSON.stringify(rows) + logs.join("\n")).not.toMatch(/SECRET|pay her|"amount"/);
    expect(logs.filter((l) => l.startsWith("[0g] intent"))).toEqual(["[0g] intent intent-model private req_intent receipt=verified status=ok"]);
  });

  it("audio -> STT -> intent; never returns the transcript", async () => {
    stubRouter((c) =>
      c.url.endsWith("/audio/transcriptions")
        ? zgJson({ text: "TRANSCRIPT pay two usdc", x_0g_trace: { request_id: "req_stt", tee_verified: true } }, 200, "req_stt")
        : chat('{"amount":"2","token":"USDC"}'),
    );
    const res = await intentPOST(audioReq("/api/intent"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.requestIds).toEqual(["req_stt", "req_intent"]);
    expect(JSON.stringify(body) + JSON.stringify(rows) + logs.join("\n")).not.toMatch(/TRANSCRIPT/);
    expect(rows.map((r) => r.kind)).toEqual(["stt", "intent"]);
  });

  it("refusal path: 200 with refusal code, row status refused", async () => {
    stubRouter(() => chat('{"refused":true}', "req_ref"));
    const body = await (await intentPOST(jsonReq("/api/intent", { text: "what's the weather" }))).json();
    expect(body).toMatchObject({ refusal: "model_refused", requestIds: ["req_ref"] });
    expect(body.intent).toBeUndefined();
    expect(rows[0]).toMatchObject({ status: "refused", requestId: "req_ref" });
  });

  it("safe-stop: 0G 503 -> 503 zg_unavailable with the real request id, no fallback intent", async () => {
    stubRouter(() => zgJson({ error: { code: "no_available_provider" }, request_id: "req_503" }, 503, "req_503"));
    const res = await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: "zg_unavailable", requestId: "req_503" });
    expect(body.intent).toBeUndefined();
    expect(calls).toHaveLength(1); // no retry in another trust mode
    expect(rows[0]).toMatchObject({ status: "error", requestId: "req_503" });
  });

  it("safe-stop on network error", async () => {
    stubRouter(() => {
      throw new TypeError("fetch failed");
    });
    const res = await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("zg_unavailable");
  });

  it("missing intent model fails clearly, before any 0G call", async () => {
    vi.stubEnv("ZG_INTENT_MODEL", "");
    stubRouter(() => chat("{}"));
    const res = await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "zg_not_configured", missing: "ZG_INTENT_MODEL" });
    expect(calls).toHaveLength(0);
  });

  it("rejects audio over 1 MiB", async () => {
    stubRouter(() => chat("{}"));
    const res = await intentPOST(audioReq("/api/intent", new Uint8Array(1024 * 1024 + 1)));
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe("hub ticket + rate limit", () => {
  it("production requires a ticket", async () => {
    vi.stubEnv("NODE_ENV", "production");
    stubRouter(() => chat('{"amount":"2","token":"USDC"}'));
    const res = await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }, {}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "ticket_required" });
    expect(calls).toHaveLength(0);
  });

  it("dev allows no ticket with a warning line", async () => {
    stubRouter(() => chat('{"amount":"2","token":"USDC"}'));
    const res = await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }, {}));
    expect(res.status).toBe(200);
    expect(logs.some((l) => l.includes("WARN /api/intent: no hub ticket"))).toBe(true);
  });

  it("an invalid or forged ticket is refused even in dev", async () => {
    stubRouter(() => chat("{}"));
    const forged = issueTicket("y".repeat(40), 600).token;
    for (const t of ["garbage", forged]) {
      const res = await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }, { "x-cpay-ticket": t }));
      expect(res.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("rate-limits per ticket id", async () => {
    vi.stubEnv("ZG_RATE_LIMIT_PER_MIN", "2");
    stubRouter(() => chat('{"amount":"2","token":"USDC"}'));
    const t = ticket();
    const send = () => intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }, { "x-cpay-ticket": t }));
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect((await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }))).status).toBe(200); // other ticket
  });
});

describe("/api/transcribe", () => {
  it("returns text + evidence; the text is not logged or stored", async () => {
    stubRouter(() => zgJson({ text: "confirm 47", x_0g_trace: { request_id: "req_c" } }, 200, "req_c"));
    const body = await (await transcribePOST(audioReq("/api/transcribe"))).json();
    expect(body).toMatchObject({ text: "confirm 47", requestId: "req_c" });
    expect(body.evidence[0]).toMatchObject({ kind: "transcribe", receiptStatus: "unverified" });
    expect(JSON.stringify(rows) + logs.join("\n")).not.toMatch(/confirm 47/);
    expect(rows[0]).toMatchObject({ kind: "stt" });
  });
});

describe("/api/speak", () => {
  it("speaks the confirm template without the code", async () => {
    stubRouter(() => new Response(new Uint8Array([0xff, 0xfb]), { headers: { "content-type": "audio/mpeg", "x-request-id": "req_tts" } }));
    const res = await speakPOST(jsonReq("/api/speak", { template: "confirmPrompt", amount: "2", token: "USDC" }));
    const body = await res.json();
    const said = "Pay 2 USDC? Say confirm and the code on your display.";
    expect(body).toMatchObject({ text: said, mime: "audio/mpeg", audioBase64: "//s=", requestId: "req_tts" });
    expect(calls[0]!.body.input).toBe(said);
    expect(rows[0]).toMatchObject({ kind: "tts", trustMode: "standard", requestId: "req_tts", receiptStatus: "standard_no_tee" });
  });

  it("ZG_TTS_API_KEY is used for TTS only; intent stays on the private key + private mode", async () => {
    vi.stubEnv("ZG_TTS_API_KEY", "sk-tts-standard");
    stubRouter((c) =>
      c.url.endsWith("/audio/speech")
        ? new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg", "x-request-id": "req_tts" } })
        : chat('{"amount":"2","token":"USDC"}'),
    );
    expect((await intentPOST(jsonReq("/api/intent", { text: "pay 2 usdc" }))).status).toBe(200);
    expect((await speakPOST(jsonReq("/api/speak", { template: "ack", amount: "2", token: "USDC" }))).status).toBe(200);
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-test-key");
    expect(calls[0]!.headers["X-0G-Provider-Trust-Mode"]).toBe("private");
    expect(calls[1]!.headers.Authorization).toBe("Bearer sk-tts-standard");
    expect(calls[1]!.headers["X-0G-Provider-Trust-Mode"]).toBeUndefined();
    expect(rows.map((r) => [r.kind, r.trustMode])).toEqual([["intent", "private"], ["tts", "standard"]]);
    expect(logs.join("\n")).not.toContain("sk-");
  });

  it("TTS failure (e.g. key not usable yet) is a clean 503 with the real evidence, no crash", async () => {
    stubRouter(() => zgJson({ error: { code: "trust_mode_mismatch" } }, 403, "req_tts_fail"));
    const res = await speakPOST(jsonReq("/api/speak", { template: "paid", amount: "2", token: "USDC" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "zg_unavailable", requestId: "req_tts_fail" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tts", status: "error", requestId: "req_tts_fail" });
  });

  it("rejects free text and bad values before any 0G call", async () => {
    stubRouter(() => new Response(""));
    expect((await speakPOST(jsonReq("/api/speak", { template: "say", text: "hi" }))).status).toBe(400);
    // the one-time confirm code must never reach TTS (OLED only)
    expect((await speakPOST(jsonReq("/api/speak", { template: "confirmAgain", code: "47" }))).status).toBe(400);
    expect((await speakPOST(jsonReq("/api/speak", { template: "confirmPrompt", amount: "2", token: "USDC", code: "47" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("/api/episode", () => {
  it("refuses plaintext episodes", async () => {
    vi.stubEnv("ZG_STORAGE_RPC_URL", "https://rpc.test");
    vi.stubEnv("ZG_STORAGE_INDEXER_URL", "https://idx.test");
    vi.stubEnv("ZG_STORAGE_PRIVATE_KEY", "0x" + "11".repeat(32));
    const plaintext = Buffer.from(JSON.stringify({ decision: "paid", requestIds: [], receipts: [], txHash: null, timestamps: {}, policyResult: null })).toString("base64");
    const res = await episodePOST(jsonReq("/api/episode", { ciphertext: plaintext, requestIds: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_ciphertext");
  });

  it("accepts a real envelope shape (storage not configured -> safe-stop, not a fake root)", async () => {
    vi.stubEnv("ZG_STORAGE_PRIVATE_KEY", "");
    const env = await encryptEpisode({ decision: "paid", requestIds: [], receipts: [], txHash: null, timestamps: {}, policyResult: null }, new Uint8Array(32).fill(7));
    const res = await episodePOST(jsonReq("/api/episode", { ciphertext: Buffer.from(env).toString("base64"), requestIds: ["req_1"] }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("zg_not_configured");
  });
});

describe("evidence row", () => {
  it("holds no content fields even if the trace carried some", () => {
    const row = toEvidenceRow({
      ts: "t",
      kind: "intent",
      model: "m",
      trustMode: "private",
      httpStatus: 200,
      requestId: "r",
      clientRequestId: "c",
      receipt: { resKey: "k", teeVerified: null, provider: "p", providerIdentity: null },
      rawTrace: { request_id: "r", provider: "p", messages: ["SECRET"], completion_text: "SECRET", nested: { prompt: "SECRET" } },
      rawZgHeaders: { "x-request-id": "r" },
      latencyMs: 12.4,
    });
    expect(JSON.stringify(row)).not.toMatch(/SECRET/);
    expect(Object.keys(row).sort()).toEqual(
      ["kind", "latencyMs", "model", "providerResponseKey", "receiptSignature", "receiptStatus", "requestId", "rootHash", "status", "teeVerified", "trace", "trustMode"].sort(),
    );
    expect(row).toMatchObject({ receiptStatus: "unverified", providerResponseKey: "k", latencyMs: 12 });
  });
});
