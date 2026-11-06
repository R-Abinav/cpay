// End-to-end proof of the REAL @cpay/railgun package on Ethereum Sepolia (no mocks):
//   1. serve apps/web/public (artifacts + kohaku_bg.wasm) and POST /api/bundler (the real route
//      handler) from a local HTTP server, exactly as the PWA would get them from our origin;
//   2. initRailgun() with a TEST seed (deriveKeys(test root).railgunSeed: same derivation as a user);
//   3. optional fresh USDC shield signed by the dev wallet (prepareShield TxData);
//   4. wait until the shield-origin USDC is POI-Valid (WETH fee balance must already be Valid);
//   5. pay() USDC to a fresh address via ERC-4337 (Pimlico through the proxy + privacy paymaster).
// Prints addresses, tx hashes, timings and bundler METHOD NAMES only. Never prints keys or the seed.
//
//   pnpm --filter @cpay/railgun artifacts
//   SHIELD=0.5 PAY=0.2 pnpm --filter @cpay/railgun prove:4337
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveKeys } from "@cpay/wallet";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { handleBundler } from "../../../apps/web/lib/server/bundler.js";
import { initRailgun } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../../../apps/web/public");
const ENV_FILE = process.env.ENV_FILE ?? "/Users/abinav/Desktop/hacks/eth-mumbai/cpay/apps/web/.env";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as const;
const WETH = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as const;

function readEnv(key: string): string | undefined {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const t = () => performance.now();
const timings: Record<string, string> = {};
const mark = (k: string, t0: number) => {
  timings[k] = `${((t() - t0) / 1000).toFixed(1)} s`;
  console.log(`[${k}] ${timings[k]}`);
};

// ---- local origin: static public dir + the real /api/bundler handler -----------------------------
const methods = new Map<string, number>();
const hosts = new Map<string, number>();
const pimlicoKey = readEnv("PIMLICO_API_KEY");
const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/bundler") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      try {
        const j = JSON.parse(body.toString());
        for (const c of Array.isArray(j) ? j : [j]) methods.set(String(c.method), (methods.get(String(c.method)) ?? 0) + 1);
      } catch { /* counted as nothing */ }
      const r = await handleBundler(
        new Request("http://local/api/bundler", { method: "POST", headers: { "content-type": String(req.headers["content-type"] ?? "") }, body }),
        { apiKey: pimlicoKey, chainId: 11155111 },
      );
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const path = resolve(publicDir, "." + decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    if (!path.startsWith(publicDir) || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": extname(path) === ".wasm" ? "application/wasm" : "application/octet-stream" });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
(globalThis as { location?: { href: string } }).location = { href: `${origin}/` };

// Count external hosts (names only) for the README list.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(typeof i === "string" ? i : i instanceof URL ? i.href : i.url);
  hosts.set(u.host, (hosts.get(u.host) ?? 0) + 1);
  return realFetch(i, init);
}) as typeof fetch;

// ---- file storage (gitignored; wallet-scan state for the TEST seed only) --------------------------
const stateFile = resolve(here, ".state", process.env.STATE ?? "prove.json");
const data: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const storage = {
  async get(k: string) { return data[k] ?? null; },
  async set(k: string, v: string) {
    data[k] = v;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(data));
  },
};

const rpcUrl = readEnv("SEPOLIA_RPC_URL")!;
const pc = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const seed = deriveKeys(sha256(utf8ToBytes("cpay/spike/railgun/test-root"))).railgunSeed;

let t0 = t();
const rg = await initRailgun({
  seed,
  chainId: 11155111,
  rpcUrl,
  usdc: USDC,
  weth: WETH,
  artifactsBase: "/railgun-artifacts/",
  wasmUrl: "/railgun/kohaku_bg.wasm",
  bundlerUrl: "/api/bundler",
  storage,
});
mark("init", t0);
console.log("0zk:", rg.address());
t0 = t();
await rg.sync();
mark("sync", t0);
const fmt = async () => {
  const b = await rg.balances();
  return `USDC valid ${formatUnits(b.usdc.valid, 6)} pending ${formatUnits(b.usdc.pending, 6)} | WETH valid ${formatUnits(b.weth.valid, 18)} pending ${formatUnits(b.weth.pending, 18)}`;
};
console.log("private:", await fmt());

const txs: Record<string, string> = {};
if (process.env.SHIELD) {
  const dev = privateKeyToAccount(readEnv("AGENT_WALLET_PRIVATE_KEY") as Hex);
  const wc = createWalletClient({ account: dev, chain: sepolia, transport: http(rpcUrl) });
  const amount = parseUnits(process.env.SHIELD, 6);
  const have = await pc.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [dev.address] });
  if (have < amount) throw new Error(`dev wallet ${dev.address} has ${formatUnits(have, 6)} USDC; needs ${process.env.SHIELD}`);
  t0 = t();
  const steps = await rg.prepareShield({ token: "USDC", amount, from: dev.address });
  for (const [i, s] of steps.entries()) {
    const h = await wc.sendTransaction({ to: s.to, data: s.data, value: s.value });
    const r = await pc.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`shield step ${i} reverted`);
    txs[i === steps.length - 1 ? "shield" : `shieldPrep${i}`] = h;
  }
  mark("shield (sign+confirm)", t0);
  console.log("shield tx:", txs.shield);
}

if (process.env.SHIELD_WETH) {
  // The agent wallet holds only ETH: prepareShield includes the WETH deposit (wrap) step.
  const dev = privateKeyToAccount(readEnv("AGENT_WALLET_PRIVATE_KEY") as Hex);
  const wc = createWalletClient({ account: dev, chain: sepolia, transport: http(rpcUrl) });
  t0 = t();
  const steps = await rg.prepareShield({ token: "WETH", amount: parseUnits(process.env.SHIELD_WETH, 18), from: dev.address });
  console.log("WETH shield steps:", steps.length);
  for (const [i, s] of steps.entries()) {
    const h = await wc.sendTransaction({ to: s.to, data: s.data, value: s.value });
    const r = await pc.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`WETH shield step ${i} reverted`);
    txs[i === steps.length - 1 ? "shieldWeth" : `shieldWethPrep${i}`] = h;
  }
  mark("shield WETH (sign+confirm)", t0);
}

if (process.env.PAY) {
  const amount = parseUnits(process.env.PAY, 6);
  const gross = (amount * 10_000n) / 9_975n;
  t0 = t();
  for (;;) {
    await rg.sync();
    const b = await rg.balances();
    console.log(`[poi-wait +${((t() - t0) / 1000).toFixed(0)} s]`, await fmt());
    if (b.usdc.valid >= gross && b.weth.valid > 0n) break;
    if (t() - t0 > Number(process.env.POI_WAIT ?? 1200) * 1000) throw new Error("POI not Valid in time");
    await new Promise((r) => setTimeout(r, 20_000));
  }
  mark("poi-wait", t0);
  const to = privateKeyToAccount(generatePrivateKey()).address;
  console.log("recipient (fresh):", to);
  const stages: Record<string, number> = {};
  t0 = t();
  const { txHash } = await rg.pay({ amount, to, onStage: (s) => { stages[s] = t(); console.log(`  stage ${s} +${((t() - t0) / 1000).toFixed(1)} s`); } });
  mark("pay total", t0);
  if (stages.submitting && stages.proving) timings["pay proving"] = `${((stages.submitting - stages.proving) / 1000).toFixed(1)} s`;
  if (stages.confirming && stages.submitting) timings["pay submit"] = `${((stages.confirming - stages.submitting) / 1000).toFixed(1)} s`;
  txs.pay = txHash;
  const got = await pc.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  const tx = await pc.getTransaction({ hash: txHash });
  console.log("pay tx:", txHash, "| recipient USDC:", formatUnits(got, 6), "| tx.from (bundler EOA):", tx.from);
  console.log("private after:", await fmt());
}

console.log("== timings ==", timings);
console.log("== txs ==", txs);
console.log("== bundler methods (via /api/bundler) ==", Object.fromEntries(methods));
console.log("== hosts (fetch) ==", Object.fromEntries(hosts));
server.close();
process.exit(0);
