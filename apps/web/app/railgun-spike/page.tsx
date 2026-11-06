"use client";

// Railgun (Kohaku) browser feasibility spike. Client-only; logs timings to the page, never to a
// server. Uses a deterministic TEST seed, not the user's passkey. Not wired into the pay flow.
//   ?rpc=<url>   RPC to use (default NEXT_PUBLIC_SEPOLIA_RPC_URL). A local anvil fork disables
//                Subsquid + POI (they cannot see fork-only commitments).
// Circuit artifacts are served from our own origin (/railgun-artifacts), never GitHub.
import { useState } from "react";

const ARTIFACT_PREFIX = "https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/refs/heads/main/artifacts/";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as const;

type Line = { t: string; msg: string };

export default function RailgunSpikePage() {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [stateFile, setStateFile] = useState<File | null>(null);
  const log = (msg: string) => setLines((l) => [...l, { t: new Date().toISOString().slice(11, 19), msg }]);

  async function run() {
    setBusy(true);
    const hosts = new Map<string, number>();
    const realFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(ARTIFACT_PREFIX)) url = `${location.origin}/railgun-artifacts/${url.slice(ARTIFACT_PREFIX.length)}`;
      const h = new URL(url, location.href).host;
      hosts.set(h, (hosts.get(h) ?? 0) + 1);
      return realFetch(url, init);
    }) as typeof fetch;
    const time = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const r = await fn();
      log(`${name}: ${(performance.now() - t0).toFixed(0)} ms`);
      return r;
    };
    try {
      const params = new URLSearchParams(location.search);
      const rpc = params.get("rpc") || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "";
      const fork = /127\.0\.0\.1|localhost/.test(rpc);
      const [rg, plugins, { viem: viemProvider }, { createPublicClient, http }, { sepolia }, { hkdf }, { sha256 }, { utf8ToBytes }, { entropyToMnemonic }, { wordlist }, { generatePrivateKey, privateKeyToAccount }] =
        await time("import modules", () =>
          Promise.all([
            import("@kohaku-eth/railgun"),
            import("@kohaku-eth/plugins"),
            import("@kohaku-eth/provider/viem"),
            import("viem"),
            import("viem/chains"),
            import("@noble/hashes/hkdf.js"),
            import("@noble/hashes/sha2.js"),
            import("@noble/hashes/utils.js"),
            import("@scure/bip39"),
            import("@scure/bip39/wordlists/english.js"),
            import("viem/accounts"),
          ]),
        );
      await time("wasm init", () => rg.ensureInitialized(fetch("/railgun/kohaku_bg.wasm"), "Off"));

      const root = sha256(utf8ToBytes("cpay/spike/railgun/test-root"));
      const seed = hkdf(sha256, root, undefined, utf8ToBytes("cpay/v1/railgun"), 32);
      const storage = new plugins.MemoryStorage();
      if (stateFile) {
        const data = JSON.parse(await stateFile.text()) as Record<string, string>;
        for (const [k, v] of Object.entries(data)) await storage.set(k, v);
        log(`preloaded sync state (${(stateFile.size / 1e6).toFixed(1)} MB)`);
      }
      const client = createPublicClient({ chain: sepolia, transport: http(rpc) });
      const host = {
        network: { fetch: (i: RequestInfo | URL, init?: RequestInit) => window.fetch(i, init) },
        storage,
        keystore: new plugins.MnemonicKeystore(entropyToMnemonic(seed, wordlist)),
        provider: viemProvider(client as never),
      };
      const plugin = await time("wallet create", () =>
        rg.createRailgunPlugin(host as never, { rpcBatchSize: 10, ...(fork ? { subsquid: false, poi: false } : {}) }),
      );
      log(`0zk address: ${await plugin.instanceId()}`);
      const asset = { __type: "erc20" as const, contract: USDC as `0x${string}` };
      const bal = await time("sync + balance", () => plugin.balance([asset]));
      log(`private USDC: ${JSON.stringify(bal.map((b) => [b.amount.toString(), b.tag ?? "?"]))}`);
      if (bal.length && bal[0]!.amount > 200_000n) {
        const to = privateKeyToAccount(generatePrivateKey()).address;
        const op = await time("unshield prepare", () => plugin.prepareUnshield({ asset, amount: 100_000n }, to));
        const inner = (plugin as unknown as { provider: { build(b: unknown): Promise<{ to: string; data: string }> } }).provider;
        const tx = await time("unshield PROVE + build (not sent)", () => inner.build(op.builder));
        log(`proved tx -> ${tx.to}, ${(tx.data.length - 2) / 2} bytes calldata`);
      } else {
        log("no spendable private balance: skipping proof");
      }
    } catch (e) {
      log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = realFetch;
      log(`hosts: ${JSON.stringify(Object.fromEntries(hosts))}`);
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 16, fontFamily: "monospace", fontSize: 13 }}>
      <h1>Railgun spike (test seed)</h1>
      <p>
        optional sync state: <input type="file" accept="application/json" onChange={(e) => setStateFile(e.target.files?.[0] ?? null)} />
      </p>
      <button id="run" disabled={busy} onClick={run}>{busy ? "running..." : "Run"}</button>
      <pre id="log">{lines.map((l) => `${l.t} ${l.msg}`).join("\n")}</pre>
    </main>
  );
}
