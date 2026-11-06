// Router client against a LOCAL FAKE router (test fixture only, see fake-router.ts).
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZeroGNotConfigured, ZeroGUnavailable, createRouterClient, replyText, type Evidence, type RouterClientOptions } from "../src/index.js";
import { TRACE, chatBody, sendJson, startFakeRouter, type Handler } from "./fake-router.js";

let fake: Awaited<ReturnType<typeof startFakeRouter>> | undefined;
let evidencePath: string;

beforeEach(async () => {
  evidencePath = join(await mkdtemp(join(tmpdir(), "zg-router-")), "evidence.jsonl");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
});

async function client(handler: Handler, over: Partial<RouterClientOptions> = {}) {
  fake = await startFakeRouter(handler);
  return createRouterClient({
    baseUrl: fake.baseUrl,
    apiKey: "sk-test",
    trustMode: "private",
    timeoutMs: 500,
    sttModel: "whisper-large-v3",
    intentModel: "glm-5.3",
    ttsModel: "minimax-speech-2.8-turbo",
    ttsVoice: "English_CalmWoman",
    evidencePath,
    ...over,
  });
}

const evidenceLines = async () =>
  (await readFile(evidencePath, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("parseIntent", () => {
  it("sends auth, trust mode, client request id and verify_tee; returns intent + IDs + receipt", async () => {
    const c = await client((_req, res) =>
      sendJson(res, 200, chatBody('{"amount":"2","token":"USDC"}', "req_body"), {
        "X-Request-ID": "req_hdr",
        "ZG-Res-Key": "chat-key-9",
        "X-0g-Gateway-Instance": "gw1",
      }),
    );
    const r = await c.parseIntent("hey pay, pay her two usdc");
    expect(r).toMatchObject({ refused: false, intent: { amount: "2", token: "USDC", mode: "lite", recipientRef: "looked-at" }, requestId: "req_body" });
    expect(r.evidence.receipt).toEqual({ resKey: "chat-key-9", teeVerified: true, provider: "0xProviderFixture", providerIdentity: "fixture" });
    expect(r.evidence.rawTrace).toEqual(TRACE("req_body"));
    expect(r.evidence.rawZgHeaders).toMatchObject({ "x-0g-gateway-instance": "gw1", "zg-res-key": "chat-key-9" });

    const req = fake!.requests[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.headers["x-0g-provider-trust-mode"]).toBe("private");
    expect(req.headers["x-client-request-id"]).toBe(r.evidence.clientRequestId);
    expect(req.body).toMatchObject({ model: "glm-5.3", verify_tee: true, temperature: 0, response_format: { type: "json_object" } });
  });

  it("uses x_0g_trace.request_id when the header is absent", async () => {
    const c = await client((_req, res) => sendJson(res, 200, chatBody('{"amount":"2","token":"USDC"}', "req_only_body")));
    expect((await c.parseIntent("pay her 2 usdc")).requestId).toBe("req_only_body");
  });

  it("honours intentTrustMode / intentModel overrides", async () => {
    const c = await client((_req, res) => sendJson(res, 200, chatBody('{"amount":"2","token":"USDC"}')), {
      intentModel: "0gm-1.0-35b-a3b",
      intentTrustMode: "verified",
    });
    const r = await c.parseIntent("pay her 2 usdc");
    expect(fake!.requests[0]!.headers["x-0g-provider-trust-mode"]).toBe("verified");
    expect(fake!.requests[0]!.body).toMatchObject({ model: "0gm-1.0-35b-a3b" });
    expect(r.evidence).toMatchObject({ model: "0gm-1.0-35b-a3b", trustMode: "verified" });
  });

  it("returns a refusal (with IDs) for invalid model output, never a guess", async () => {
    const c = await client((_req, res) => sendJson(res, 200, chatBody("I think you meant 2 USDC?", "req_r"), { "X-Request-ID": "edge_1, req_r" }));
    const r = await c.parseIntent("pay her something");
    expect(r).toMatchObject({ refused: true, reason: "invalid_json", requestId: "req_r" });
    expect("intent" in r).toBe(false);
  });

  it("safe-stops on a 2xx with no request ID anywhere, and still records evidence", async () => {
    const c = await client((_req, res) => sendJson(res, 200, { choices: [{ message: { content: '{"amount":"2","token":"USDC"}' } }] }));
    const err = await c.parseIntent("pay her 2 usdc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZeroGUnavailable);
    expect((err as ZeroGUnavailable).evidence).toMatchObject({ httpStatus: 200, requestId: null, error: "missing_request_id" });
    expect((await evidenceLines())[0]).toMatchObject({ kind: "intent", error: "missing_request_id" });
  });

  it("safe-stops on timeout with a clientRequestId in the evidence", async () => {
    const c = await client(() => {
      /* never answers */
    }, { timeoutMs: 100 });
    const err = await c.parseIntent("pay her 2 usdc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZeroGUnavailable);
    expect((err as ZeroGUnavailable).message).toMatch(/timeout/);
    const ev = (err as ZeroGUnavailable).evidence!;
    expect(ev).toMatchObject({ httpStatus: null, requestId: null, error: "timeout" });
    expect(ev.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("safe-stops on non-2xx and keeps the error body's request ID + code", async () => {
    const c = await client((_req, res) =>
      sendJson(res, 503, { error: { code: "no_available_provider", message: "none" }, request_id: "req_503" }),
    );
    const err = (await c.parseIntent("pay her 2 usdc").catch((e: unknown) => e)) as ZeroGUnavailable;
    expect(err).toBeInstanceOf(ZeroGUnavailable);
    expect(err.evidence).toMatchObject({ httpStatus: 503, requestId: "req_503", error: "http_503:no_available_provider" });
  });

  it("safe-stops on a network error", async () => {
    const c = createRouterClient({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test", trustMode: "private", timeoutMs: 500, intentModel: "m" });
    const err = (await c.parseIntent("x").catch((e: unknown) => e)) as ZeroGUnavailable;
    expect(err).toBeInstanceOf(ZeroGUnavailable);
    expect(err.evidence).toMatchObject({ error: "network" });
  });

  it("fails clearly before any network call when the model is not configured", async () => {
    const c = await client((_req, res) => sendJson(res, 200, chatBody('{"amount":"2","token":"USDC"}')), { intentModel: undefined });
    const err = await c.parseIntent("pay her 2 usdc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZeroGNotConfigured);
    expect((err as Error).message).toBe("ZG_INTENT_MODEL is not set");
    expect(fake!.requests).toHaveLength(0);
  });

  it("sends evidence (refusal code included) to onEvidence instead of the JSONL", async () => {
    const seen: Evidence[] = [];
    const c = await client((_req, res) => sendJson(res, 200, chatBody('{"refused":true}', "req_ref")), {
      onEvidence: (ev) => {
        seen.push(ev);
      },
    });
    const r = await c.parseIntent("hello there");
    expect(r).toMatchObject({ refused: true, reason: "model_refused" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "intent", requestId: "req_ref", refusal: "model_refused" });
    await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
  });

  it("a throwing evidence sink never turns a completed call into a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await client((_req, res) => sendJson(res, 200, chatBody('{"amount":"2","token":"USDC"}', "req_ok")), {
      onEvidence: () => {
        throw new Error("db down");
      },
    });
    expect(await c.parseIntent("pay 2 usdc")).toMatchObject({ refused: false, requestId: "req_ok" });
  });

  it("uses sttTrustMode for transcribe", async () => {
    const c = await client((_req, res) => sendJson(res, 200, { text: "x", x_0g_trace: TRACE("req_s") }), { sttTrustMode: "verified" });
    const r = await c.transcribe(new Uint8Array([1]));
    expect(fake!.requests[0]!.headers["x-0g-provider-trust-mode"]).toBe("verified");
    expect(r.evidence.trustMode).toBe("verified");
  });

  it("never writes the transcript or model output into evidence", async () => {
    const c = await client((_req, res) => sendJson(res, 200, chatBody('{"amount":"7","token":"USDC"}', "req_p")));
    await c.parseIntent("SECRET-TRANSCRIPT pay her 7 usdc");
    const file = await readFile(evidencePath, "utf8");
    expect(file).not.toMatch(/SECRET-TRANSCRIPT/);
    expect(file).not.toMatch(/"amount"/);
  });
});

describe("transcribe", () => {
  it("uploads audio as multipart (private providers refuse JSON audio) and returns text + IDs", async () => {
    const c = await client((_req, res) =>
      sendJson(res, 200, { text: "pay her two usdc", x_0g_trace: TRACE("req_stt") }, { "X-Request-ID": "req_stt" }),
    );
    const r = await c.transcribe(new Uint8Array([1, 2, 3]), { filename: "clip.wav" });
    expect(r).toMatchObject({ text: "pay her two usdc", requestId: "req_stt" });
    const req = fake!.requests[0]!;
    expect(req.path).toBe("/v1/audio/transcriptions");
    expect(req.headers["x-0g-provider-trust-mode"]).toBe("private");
    expect(String(req.headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
    const body = String(req.body);
    for (const part of ['name="model"', "whisper-large-v3", 'name="file"; filename="clip.wav"', 'name="language"', 'name="response_format"', 'name="verify_tee"']) {
      expect(body).toContain(part);
    }
    expect(body).not.toContain("file_base64");
    expect(await readFile(evidencePath, "utf8")).not.toMatch(/pay her/);
  });

  it("accepts a Blob and safe-stops on a body without text", async () => {
    const c = await client((_req, res) => sendJson(res, 200, { x_0g_trace: TRACE("req_x") }));
    const err = await c.transcribe(new Blob([new Uint8Array([9])])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZeroGUnavailable);
  });
});

describe("speak", () => {
  it("refuses non-template text before any network call", async () => {
    const c = await client((_req, res) => sendJson(res, 200, {}));
    await expect(c.speak("Paid 2 USDC to Alice.")).rejects.toThrow(/not a replyText/);
    expect(fake!.requests).toHaveLength(0);
  });

  it("posts the exact documented body, no trust header for standard TTS, returns audio + request ID", async () => {
    const c = await client((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg", "x-request-id": "req_tts" });
      res.end(Buffer.from([0xff, 0xfb, 0x90]));
    });
    const text = replyText("ack", { amount: "2", token: "USDC" });
    const r = await c.speak(text);
    expect(r).toMatchObject({ mime: "audio/mpeg", requestId: "req_tts" });
    expect(new Uint8Array(r.audio)).toEqual(new Uint8Array([0xff, 0xfb, 0x90]));
    const req = fake!.requests[0]!;
    expect(req.path).toBe("/v1/audio/speech");
    expect(req.headers["x-0g-provider-trust-mode"]).toBeUndefined();
    expect(req.body).toEqual({ model: "minimax-speech-2.8-turbo", input: text, voice: "English_CalmWoman", response_format: "mp3" });
    expect(r.evidence).toMatchObject({ kind: "speak", trustMode: "standard", rawTrace: null });
  });

  it("uses the TTS key ONLY for speak(); STT and intent stay on the private key and private mode", async () => {
    const c = await client(
      (req, res) => {
        if (req.path === "/v1/audio/speech") {
          res.writeHead(200, { "content-type": "audio/mpeg", "x-request-id": "req_tts2" });
          return void res.end(Buffer.from([1]));
        }
        if (req.path === "/v1/audio/transcriptions") return sendJson(res, 200, { text: "pay 2 usdc", x_0g_trace: TRACE("req_stt2") }, { "X-Request-ID": "req_stt2" });
        return sendJson(res, 200, chatBody('{"amount":"2","token":"USDC"}', "req_int2"), { "X-Request-ID": "req_int2" });
      },
      { apiKey: "sk-private", ttsApiKey: "sk-tts-standard", ttsTrustMode: "standard" },
    );
    await c.transcribe(new Blob([new Uint8Array([1, 2])]));
    await c.parseIntent("pay 2 usdc");
    const spoken = await c.speak(replyText("confirmPrompt", { amount: "2", token: "USDC" }));
    const [stt, intent, tts] = fake!.requests;
    expect(stt!.headers.authorization).toBe("Bearer sk-private");
    expect(stt!.headers["x-0g-provider-trust-mode"]).toBe("private");
    expect(intent!.headers.authorization).toBe("Bearer sk-private");
    expect(intent!.headers["x-0g-provider-trust-mode"]).toBe("private");
    expect(tts!.headers.authorization).toBe("Bearer sk-tts-standard");
    expect(tts!.headers["x-0g-provider-trust-mode"]).toBeUndefined();
    expect((tts!.body as { input: string }).input).toBe("Pay 2 USDC? Say confirm and the code on your display.");
    expect(spoken.evidence).toMatchObject({ kind: "speak", trustMode: "standard", requestId: "req_tts2", receipt: null });
    const lines = await evidenceLines();
    expect(lines.map((l) => [l.kind, l.trustMode])).toEqual([["transcribe", "private"], ["intent", "private"], ["speak", "standard"]]);
    expect(JSON.stringify(lines)).not.toContain("sk-");
  });

  it("falls back to the router key for TTS when no TTS key is set", async () => {
    const c = await client((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg", "x-request-id": "req_tts3" });
      res.end(Buffer.from([1]));
    });
    await c.speak(replyText("paid", { amount: "2", token: "USDC" }));
    expect(fake!.requests[0]!.headers.authorization).toBe("Bearer sk-test");
  });

  it("safe-stops when a 2xx carries JSON instead of audio", async () => {
    const c = await client((_req, res) => sendJson(res, 200, { ok: true }, { "x-request-id": "req_j" }));
    await expect(c.speak(replyText("cancelled"))).rejects.toBeInstanceOf(ZeroGUnavailable);
  });
});
