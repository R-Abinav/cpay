// Router client against a LOCAL FAKE router (test fixture only, see fake-router.ts).
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZeroGUnavailable, createRouterClient, replyText, type RouterClientOptions } from "../src/index.js";
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
    expect(r).toMatchObject({ refused: false, intent: { amount: "2", token: "USDC", mode: "lite", recipientRef: "looked-at" }, requestId: "req_hdr" });
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
    const c = await client((_req, res) => sendJson(res, 200, chatBody("I think you meant 2 USDC?"), { "X-Request-ID": "req_r" }));
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
    const c = createRouterClient({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test", trustMode: "private", timeoutMs: 500 });
    const err = (await c.parseIntent("x").catch((e: unknown) => e)) as ZeroGUnavailable;
    expect(err).toBeInstanceOf(ZeroGUnavailable);
    expect(err.evidence).toMatchObject({ error: "network" });
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
  it("posts base64 audio as JSON with trust mode + verify_tee and returns text + IDs", async () => {
    const c = await client((_req, res) =>
      sendJson(res, 200, { text: "pay her two usdc", x_0g_trace: TRACE("req_stt") }, { "X-Request-ID": "req_stt" }),
    );
    const r = await c.transcribe(new Uint8Array([1, 2, 3]), { filename: "clip.wav" });
    expect(r).toMatchObject({ text: "pay her two usdc", requestId: "req_stt" });
    const req = fake!.requests[0]!;
    expect(req.path).toBe("/v1/audio/transcriptions");
    expect(req.headers["x-0g-provider-trust-mode"]).toBe("private");
    expect(req.body).toEqual({
      model: "whisper-large-v3",
      file_base64: "AQID",
      filename: "clip.wav",
      language: "en",
      response_format: "json",
      verify_tee: true,
    });
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

  it("safe-stops when a 2xx carries JSON instead of audio", async () => {
    const c = await client((_req, res) => sendJson(res, 200, { ok: true }, { "x-request-id": "req_j" }));
    await expect(c.speak(replyText("cancelled"))).rejects.toBeInstanceOf(ZeroGUnavailable);
  });
});
