import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, __resetBundlerRateForTests, handleBundler } from "../lib/server/bundler.js";

const KEY = "test-key-not-real";
const seen: { url: string; body: string }[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  seen.push({ url, body: String(init.body) });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
}) as unknown as typeof fetch;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/bundler", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const call = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [] });

describe("/api/bundler", () => {
  beforeEach(() => {
    seen.length = 0;
    __resetBundlerRateForTests();
  });

  it("forwards an allowed method to Pimlico with the server key", async () => {
    const r = await handleBundler(post(call("eth_sendUserOperation")), { apiKey: KEY, chainId: 11155111, fetch: fakeFetch });
    expect(r.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.pimlico.io/v2/sepolia/rpc?apikey=${KEY}`);
    expect(JSON.parse(seen[0]!.body).method).toBe("eth_sendUserOperation");
    expect(await r.text()).not.toContain(KEY);
  });

  it("rejects methods outside the allow-list", async () => {
    for (const m of ["eth_sendRawTransaction", "eth_call", "pimlico_sponsorUserOperation", "debug_bundler_dumpMempool"]) {
      const r = await handleBundler(post(call(m)), { apiKey: KEY, chainId: 11155111, fetch: fakeFetch });
      expect(r.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it("rejects oversized bodies, bad JSON and wrong content type", async () => {
    const big = JSON.stringify({ ...call("eth_sendUserOperation"), params: ["x".repeat(MAX_BODY_BYTES)] });
    expect((await handleBundler(post(big), { apiKey: KEY, chainId: 11155111, fetch: fakeFetch })).status).toBe(413);
    expect((await handleBundler(post("{nope"), { apiKey: KEY, chainId: 11155111, fetch: fakeFetch })).status).toBe(400);
    expect((await handleBundler(post(call("eth_chainId"), { "content-type": "text/plain" }), { apiKey: KEY, chainId: 11155111, fetch: fakeFetch })).status).toBe(415);
    expect(seen).toHaveLength(0);
  });

  it("refuses when the key is missing (no fallback)", async () => {
    const r = await handleBundler(post(call("eth_chainId")), { apiKey: undefined, chainId: 11155111, fetch: fakeFetch });
    expect(r.status).toBe(503);
  });

  it("rate-limits with one global bucket", async () => {
    let last = 200;
    for (let i = 0; i < 601; i++) last = (await handleBundler(post(call("eth_chainId")), { apiKey: KEY, chainId: 11155111, fetch: fakeFetch })).status;
    expect(last).toBe(429);
  });

  it("never echoes an upstream failure (it may contain the key)", async () => {
    const boom = (async () => { throw new Error(`fetch failed for https://api.pimlico.io/?apikey=${KEY}`); }) as unknown as typeof fetch;
    const r = await handleBundler(post(call("eth_chainId")), { apiKey: KEY, chainId: 11155111, fetch: boom });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(KEY);
  });
});
