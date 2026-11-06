import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRailgunArtifactOriginInterceptor } from "../src/browser-engine.js";

describe("Railgun artifact client routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rewrites the SDK IPFS URL to the app origin", async () => {
    vi.stubGlobal("location", { origin: "https://cpay.example" });
    await installRailgunArtifactOriginInterceptor();
    const handlers = (axios.interceptors.request as unknown as { handlers: Array<{ fulfilled?: (config: any) => any }> }).handlers;
    const handler = [...handlers].reverse().find((candidate) => candidate?.fulfilled)?.fulfilled;
    expect(handler).toBeDefined();
    const config = handler?.({ url: "https://ipfs-lb.com/ipfs/QmPinned/circuits/02x02/zkey.br" });
    expect(config.url).toBe("/api/railgun/artifacts/QmPinned/circuits/02x02/zkey.br");
    expect(config.baseURL).toBe("https://cpay.example");
  });
});
