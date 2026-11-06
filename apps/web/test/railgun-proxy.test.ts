import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as rpcPost } from "../app/api/railgun/rpc/route.js";
import { POST as poiPost } from "../app/api/railgun/poi/route.js";

describe("Railgun upstream proxies", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards allowed Sepolia JSON-RPC through the server", async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }), { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const response = await rpcPost(new Request("http://localhost/api/railgun/rpc", {
      method: "POST", headers: { "cf-connecting-ip": "192.0.2.10" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: "0xaa36a7" });
    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0]?.[0])).toContain("ethereum-sepolia-rpc.publicnode.com");
  });

  it("allows only known Railgun POI methods through the fixed upstream", async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }), { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const response = await poiPost(new Request("http://localhost/api/railgun/poi", {
      method: "POST", headers: { "cf-connecting-ip": "192.0.2.11" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ppoi_health", params: {} }),
    }) as never);
    expect(response.status).toBe(200);
    expect(String(upstream.mock.calls[0]?.[0])).toBe("https://poi-sepolia.railgun.org");
  });

  it("rejects missing trusted client IPs and unsupported RPC methods", async () => {
    const noIp = await rpcPost(new Request("http://localhost/api/railgun/rpc", { method: "POST", body: "{}" }) as never);
    expect(noIp.status).toBe(503);
    const badMethod = await rpcPost(new Request("http://localhost/api/railgun/rpc", {
      method: "POST", headers: { "cf-connecting-ip": "192.0.2.12" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "personal_sendTransaction", params: [] }),
    }) as never);
    expect(badMethod.status).toBe(400);
  });
});
