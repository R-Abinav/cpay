// Railgun (Kohaku) spike on Ethereum Sepolia. Real chain only.
// Prints addresses, timings, tx hashes and contacted HOSTS. Never prints keys, seeds or payloads.
//
//   pnpm --filter @cpay/railgun exec tsx spike/run.ts            # create wallet + sync + balance
//   SHIELD=0.5 ... tsx spike/run.ts                              # also shield 0.5 USDC from the dev wallet
//   UNSHIELD=0.1 ... tsx spike/run.ts                            # also prove + self-submit an unshield
//   ARTIFACTS=<dir> ...                                          # serve circuit artifacts from a local dir
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MnemonicKeystore } from "@kohaku-eth/plugins";
import type { Host, Storage } from "@kohaku-eth/plugins";
import { viem as viemProvider } from "@kohaku-eth/provider/viem";
import { createRailgunPlugin } from "@kohaku-eth/railgun";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { initKohaku, ms, readEnv } from "./common.js";

const here = dirname(fileURLToPath(import.meta.url));
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const ARTIFACT_PREFIX = "https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/refs/heads/main/artifacts/";

// --- host logging: record only hostnames (no URLs with query, no bodies) + artifact sizes ---
const hosts = new Map<string, number>();
const artifactBytes = new Map<string, number>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(ARTIFACT_PREFIX) && process.env.ARTIFACTS) {
    const rel = url.slice(ARTIFACT_PREFIX.length);
    const buf = readFileSync(resolve(process.env.ARTIFACTS, rel));
    hosts.set("local-artifacts", (hosts.get("local-artifacts") ?? 0) + 1);
    artifactBytes.set(rel, buf.byteLength);
    // reqwest (wasm) parses response.url, so a synthetic Response must carry one.
    const r = new Response(buf);
    Object.defineProperty(r, "url", { value: url });
    return r;
  }
  const h = new URL(url).host;
  hosts.set(h, (hosts.get(h) ?? 0) + 1);
  const res = await realFetch(input, init);
  if (url.startsWith(ARTIFACT_PREFIX)) {
    const rel = url.slice(ARTIFACT_PREFIX.length);
    const buf = await res.clone().arrayBuffer();
    artifactBytes.set(rel, buf.byteLength);
    if (process.env.SAVE_ARTIFACTS) {
      const out = resolve(process.env.SAVE_ARTIFACTS, rel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(buf));
    }
  }
  return res;
}) as typeof fetch;

// --- file-backed storage for sync state (gitignored; holds wallet-scan state, never commit) ---
class FileStorage implements Storage {
  readonly _brand = "Storage" as const;
  private data: Record<string, string>;
  constructor(private path: string) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  async get(k: string) { return this.data[k] ?? null; }
  async set(k: string, v: string) {
    this.data[k] = v;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data));
  }
}

const timings: Record<string, string> = {};
const txs: Record<string, string> = {};
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  const r = await fn();
  timings[name] = ms(t0);
  console.log(`[${name}] ${timings[name]}`);
  return r;
};

// FORK_RPC points at a local anvil fork for the no-funds proof dry run (NOT a real tx).
const rpc = process.env.FORK_RPC || readEnv("SEPOLIA_RPC_URL") || readEnv("NEXT_PUBLIC_SEPOLIA_RPC_URL");
if (!rpc) throw new Error("SEPOLIA_RPC_URL missing in apps/web/.env");
hosts.set(new URL(rpc).host, 0); // listed; RPC traffic goes through viem's own fetch
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });

// Deterministic TEST seed (same shape as packages/wallet: HKDF(root, "cpay/v1/railgun", 32)).
const testRoot = sha256(utf8ToBytes("cpay/spike/railgun/test-root"));
const railgunSeed = hkdf(sha256, testRoot, undefined, utf8ToBytes("cpay/v1/railgun"), 32);
const mnemonic = entropyToMnemonic(railgunSeed, wordlist); // 24 words, never printed

await step("wasm-init", () => initKohaku((process.env.RG_LOG as never) ?? "Off"));

const host: Host = {
  network: { fetch: (i, init) => globalThis.fetch(i, init) },
  storage: new FileStorage(resolve(here, process.env.FORK_RPC ? ".state/fork.json" : ".state/storage.json")),
  keystore: new MnemonicKeystore(mnemonic),
  provider: viemProvider(publicClient as never),
};

const plugin = await step("wallet-create", () => createRailgunPlugin(host, {
  rpcBatchSize: 10,
  // On a local fork the indexer/POI node cannot see fork-only commitments.
  ...(process.env.FORK_RPC ? { subsquid: false, poi: false } : {}),
}));
const zkAddress = await plugin.instanceId();
console.log("0zk address:", zkAddress);

// Kohaku compares contract addresses case-sensitively against lowercase engine values.
const usdcAsset = { __type: "erc20" as const, contract: USDC.toLowerCase() as Hex };
const balance = await step("sync+balance", () => plugin.balance([usdcAsset]));
console.log("private USDC:", balance.map((b) => `${formatUnits(b.amount, 6)} (${b.tag ?? "?"})`));

// --- shield (needs the dev wallet funded) ---
if (process.env.SHIELD) {
  const pk = readEnv("AGENT_WALLET_PRIVATE_KEY") as Hex;
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  const amount = parseUnits(process.env.SHIELD, 6);
  const have = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const eth = await publicClient.getBalance({ address: account.address });
  if (have < amount || eth === 0n) {
    console.log(`FUNDING NEEDED: ${account.address} has ${formatUnits(have, 6)} USDC, ${eth} wei ETH; needs >= ${process.env.SHIELD} USDC + ~0.01 ETH`);
  } else {
    const [shieldTx] = await step("shield-prepare", () => plugin.prepareShield({ asset: usdcAsset, amount }));
    const allowance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [account.address, shieldTx!.to as Hex] });
    if (allowance < amount) {
      const h = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [shieldTx!.to as Hex, amount] });
      txs.approve = h;
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    const h = await step("shield-send+confirm", async () => {
      const hash = await wallet.sendTransaction({ to: shieldTx!.to as Hex, data: shieldTx!.data as Hex, value: shieldTx!.value });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("shield reverted");
      return hash;
    });
    txs.shield = h;
    console.log("shield tx:", h);
    const b2 = await step("sync-after-shield", () => plugin.balance([usdcAsset]));
    console.log("private USDC:", b2.map((b) => `${formatUnits(b.amount, 6)} (${b.tag ?? "?"})`));
  }
}

// --- wait for POI "Valid" (testnet shield standby) before spending ---
if (process.env.UNSHIELD && !process.env.FORK_RPC) {
  const t0 = performance.now();
  const limit = Number(process.env.POI_WAIT ?? 600) * 1000;
  for (;;) {
    const b = await plugin.balance([usdcAsset]);
    const tags = b.map((x) => `${formatUnits(x.amount, 6)}:${x.tag ?? "?"}`).join(", ");
    console.log(`[poi-poll +${ms(t0)}] ${tags}`);
    if (b.some((x) => x.tag === "Valid" && x.amount >= parseUnits(process.env.UNSHIELD, 6))) break;
    if (performance.now() - t0 > limit) throw new Error("POI not Valid within POI_WAIT");
    await new Promise((r) => setTimeout(r, 20_000));
  }
  timings["poi-wait"] = ms(t0);
}

// --- unshield: real proof, self-submitted from a FRESH throwaway EOA (spike only) ---
if (process.env.UNSHIELD) {
  const amount = parseUnits(process.env.UNSHIELD, 6);
  const to = privateKeyToAccount(generatePrivateKey()).address; // fresh recipient
  console.log("unshield recipient (fresh):", to);
  const op = await step("unshield-prepare(select notes)", () => plugin.prepareUnshield({ asset: usdcAsset, amount }, to));
  // RailgunProvider.build() runs the Groth16 prover (and POI proofs if enabled) and returns TxData.
  const inner = (plugin as unknown as { provider: { build(b: unknown): Promise<{ to: Hex; data: Hex; value: string | bigint }> } }).provider;
  const tx = await step("unshield-prove+build", () => inner.build(op.builder));
  console.log("unshield tx target:", tx.to, "calldata bytes:", (tx.data.length - 2) / 2);
  if (process.env.SUBMIT) {
    const pk = readEnv("AGENT_WALLET_PRIVATE_KEY") as Hex;
    const funder = createWalletClient({ account: privateKeyToAccount(pk), chain: sepolia, transport: http(rpc) });
    const throwawayKey = generatePrivateKey(); // in memory only
    const throwaway = privateKeyToAccount(throwawayKey);
    const fund = await funder.sendTransaction({ to: throwaway.address, value: parseEther(process.env.GAS_ETH ?? "0.005") });
    txs.fundThrowaway = fund;
    await publicClient.waitForTransactionReceipt({ hash: fund });
    const sender = createWalletClient({ account: throwaway, chain: sepolia, transport: http(rpc) });
    const h = await step("unshield-send+confirm", async () => {
      const hash = await sender.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("unshield reverted");
      return hash;
    });
    txs.unshield = h;
    const got = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [to] });
    console.log("recipient USDC:", formatUnits(got, 6));
  }
}

console.log("\n== timings ==", timings);
console.log("== txs ==", txs);
console.log("== hosts contacted (fetch) ==", Object.fromEntries(hosts));
console.log("== artifacts ==", Object.fromEntries(artifactBytes));
process.exit(0);
