// Railgun unshield via Kohaku's real submission path: ERC-4337 UserOperation through a Pimlico
// bundler, gas sponsored by the Railgun privacy paymaster, fee paid from the SHIELDED WETH balance.
// No wallet of ours pays gas for the unshield. Real Sepolia only. Never prints keys.
//
//   WETH_SHIELD=0.005  wrap + shield this much ETH as WETH first (fee balance for the paymaster)
//   UNSHIELD=0.2       unshield this much USDC to a fresh address via the bundler
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { Bundler, Signer, createRailgunPlugin } from "@kohaku-eth/railgun";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseAbi, parseEther, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { initKohaku, ms, readEnv } from "./common.js";

const here = dirname(fileURLToPath(import.meta.url));
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as const;
const WETH = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as const;

function readMainEnv(key: string): string | undefined {
  const p = "/Users/abinav/Desktop/hacks/eth-mumbai/cpay/apps/web/.env";
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

class FileStorage implements Storage {
  readonly _brand = "Storage" as const;
  private data: Record<string, string>;
  constructor(private path: string) { this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; }
  async get(k: string) { return this.data[k] ?? null; }
  async set(k: string, v: string) { this.data[k] = v; mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.data)); }
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

const rpc = readEnv("SEPOLIA_RPC_URL")!;
const pimlicoKey = readMainEnv("PIMLICO_API_KEY") ?? readEnv("PIMLICO_API_KEY");
if (!pimlicoKey) throw new Error("PIMLICO_API_KEY missing");
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });

await initKohaku((process.env.RG_LOG as never) ?? "Off");
const root = sha256(utf8ToBytes("cpay/spike/railgun/test-root"));
const seed = hkdf(sha256, root, undefined, utf8ToBytes("cpay/v1/railgun"), 32);
const host: Host = {
  network: { fetch: (i, init) => globalThis.fetch(i, init) },
  storage: new FileStorage(resolve(here, process.env.STATE_FILE ?? ".state/fresh.json")),
  keystore: new MnemonicKeystore(entropyToMnemonic(seed, wordlist)),
  provider: viemProvider(publicClient as never),
};
// Fresh, unfunded EOA used as the 7702 smart account (UserOp sender). Never funded: the paymaster pays.
const aaKey = generatePrivateKey();
const aaSigner = Signer.privateKey(aaKey);
console.log("7702 smart account (fresh, 0 ETH):", aaSigner.address);
const plugin = await step("wallet-create", () =>
  createRailgunPlugin(host, {
    rpcBatchSize: 10,
    bundler: { bundler: Bundler.pimlico(`https://api.pimlico.io/v2/sepolia/rpc?apikey=${pimlicoKey}`), smartAccountSigner: aaSigner },
  }),
);
const assets = [{ __type: "erc20" as const, contract: USDC as Hex }, { __type: "erc20" as const, contract: WETH as Hex }];
const show = (b: Awaited<ReturnType<typeof plugin.balance>>) =>
  b.map((x) => `${x.asset.__type === "erc20" && x.asset.contract === WETH ? "WETH" : "USDC"} ${formatUnits(x.amount, x.asset.__type === "erc20" && x.asset.contract === WETH ? 18 : 6)}:${x.tag ?? "?"}`).join(", ");
console.log("private:", show(await step("sync+balance", () => plugin.balance(assets))));

if (process.env.WETH_SHIELD) {
  const dev = createWalletClient({ account: privateKeyToAccount(readEnv("AGENT_WALLET_PRIVATE_KEY") as Hex), chain: sepolia, transport: http(rpc) });
  const amount = parseEther(process.env.WETH_SHIELD);
  const wrap = await dev.writeContract({ address: WETH, abi: parseAbi(["function deposit() payable"]), functionName: "deposit", value: amount });
  await publicClient.waitForTransactionReceipt({ hash: wrap });
  txs.wrap = wrap;
  const [sh] = await plugin.prepareShield({ asset: { __type: "erc20", contract: WETH }, amount });
  const ap = await dev.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [sh!.to as Hex, amount] });
  await publicClient.waitForTransactionReceipt({ hash: ap });
  txs.approveWeth = ap;
  txs.shieldWeth = await step("shield-weth", async () => {
    const h = await dev.sendTransaction({ to: sh!.to as Hex, data: sh!.data as Hex, value: sh!.value });
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error("shield reverted");
    return h;
  });
  console.log("shield WETH tx:", txs.shieldWeth);
}

if (process.env.UNSHIELD) {
  const t0 = performance.now();
  for (;;) {
    const b = await plugin.balance(assets);
    console.log(`[poi-poll +${ms(t0)}] ${show(b)}`);
    const weth = b.find((x) => x.asset.__type === "erc20" && x.asset.contract === WETH && x.tag === "Valid");
    const usdc = b.find((x) => x.asset.__type === "erc20" && x.asset.contract === USDC && x.tag === "Valid");
    if (weth && usdc) break;
    if (performance.now() - t0 > 900_000) throw new Error("POI not Valid in 15 min");
    await new Promise((r) => setTimeout(r, 20_000));
  }
  timings["poi-wait"] = ms(t0);
  const to = privateKeyToAccount(generatePrivateKey()).address;
  console.log("unshield recipient (fresh):", to);
  const op = await step("unshield-prepare", () => plugin.prepareUnshield({ asset: assets[0]!, amount: parseUnits(process.env.UNSHIELD, 6) }, to));
  // broadcast(): builds the fee-converging UserOp (proves inside), signs with the 7702 account,
  // sends to Pimlico, waits for the receipt, then re-syncs.
  await step("prove+userop+bundle+confirm", () => plugin.broadcast(op));
  const got = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  console.log("recipient USDC:", formatUnits(got, 6));
  const logs = await publicClient.getContractEvents({ address: USDC, abi: erc20Abi, eventName: "Transfer", args: { to }, fromBlock: (await publicClient.getBlockNumber()) - 50n });
  if (logs[0]) txs.unshieldUserOpTx = logs[0].transactionHash;
}
console.log("== timings ==", timings);
console.log("== txs ==", txs);
process.exit(0);
