// DEV ONLY, Base Sepolia testnet only. Proves the private-receive path on a real chain with the real wallet code:
//   pnpm --filter @cpay/wallet onetime:roundtrip [amountUSDC=0.02]
//
//   1. random 32-byte root -> deriveStealthKeys -> newOneTimeDestination (the "recipient phone"; IndexedDB is
//      faked in memory here)
//   2. payOneTime from AGENT_WALLET_PRIVATE_KEY (a testnet dev key, read from env only, never printed): USDC + gas drop
//   3. sendFromPrivate: half of it to a fresh address, signed by the one-time key only
//   4. sweepOneTime: the rest + leftover gas-drop ETH to another fresh address
// Prints tx links. Checks the dev key's balance first and stops if it can't cover the run; with ETH but too
// little USDC it runs only the gas drop + leftover-ETH sweep.
// The random root is written to ./data (git-ignored, 0600) so stuck test funds can be recovered.
import "fake-indexeddb/auto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverSpendKey, sweepEth } from "@cpay/stealth";
import {
  DEFAULT_GAS_DROP_WEI,
  chainOf,
  deriveStealthKeys,
  newOneTimeDestination,
  payOneTime,
  sendFromPrivate,
  sweepOneTime,
  txUrl,
  type ChainConfig,
} from "../src/index.js";

const cfg: ChainConfig = {
  chainId: 84532,
  rpcUrl: process.env.ROUNDTRIP_RPC_URL || "https://sepolia.base.org",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  explorerUrl: "https://sepolia.basescan.org",
};

const key = process.env.AGENT_WALLET_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.log("AGENT_WALLET_PRIVATE_KEY is not set (or malformed) in .env / apps/web/.env: skipping.");
  process.exit(0);
}
const agent = privateKeyToAccount(key as Hex);
const amount = parseUnits(process.argv[2] ?? "0.02", 6);
const pub = createPublicClient({ chain: chainOf(cfg), transport: http(cfg.rpcUrl) });

const chainId = await pub.getChainId();
if (chainId !== 84532) throw new Error(`RPC is on chain ${chainId}; this script runs on Base Sepolia (84532) only`);

const [usdc, eth] = await Promise.all([
  pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [agent.address] }),
  pub.getBalance({ address: agent.address }),
]);
console.log(`dev wallet ${agent.address}: ${formatUnits(usdc, 6)} USDC, ${formatEther(eth)} ETH`);
if (eth < DEFAULT_GAS_DROP_WEI * 2n) {
  console.log(`not enough ETH to run (need ${formatEther(DEFAULT_GAS_DROP_WEI * 2n)}): skipping.`);
  process.exit(0);
}
const ethOnly = usdc < amount;
if (ethOnly) console.log(`only ${formatUnits(usdc, 6)} USDC (need ${formatUnits(amount, 6)}): running the gas-drop + ETH-sweep leg only.`);

// 1. the recipient phone
const root = crypto.getRandomValues(new Uint8Array(32));
const dataDir = resolve(import.meta.dirname, "../../../data");
mkdirSync(dataDir, { recursive: true });
const rootFile = resolve(dataDir, `onetime-roundtrip-${Date.now()}.json`);
writeFileSync(rootFile, JSON.stringify({ root: Buffer.from(root).toString("hex") }), { mode: 0o600 });
const keys = deriveStealthKeys(root);
const dest = await newOneTimeDestination(keys);
console.log(`one-time destination ${dest.address} (root saved to ${rootFile})`);

if (ethOnly) {
  // gas drop exactly as payOneTime sends it, then sweepEth signed by the recovered one-time key
  const w = createWalletClient({ account: agent, chain: chainOf(cfg), transport: http(cfg.rpcUrl) });
  const drop = await w.sendTransaction({ to: dest.address, value: DEFAULT_GAS_DROP_WEI });
  if ((await pub.waitForTransactionReceipt({ hash: drop })).status !== "success") throw new Error("gas drop reverted");
  console.log(`gas drop ${txUrl(cfg, drop)}`);
  const sink = privateKeyToAccount(generatePrivateKey()).address;
  const r = await sweepEth({ stealthPrivateKey: recoverSpendKey(keys, dest), to: sink, chain: chainOf(cfg), transport: http(cfg.rpcUrl) });
  if (!r) throw new Error("sweepEth returned null on a full gas drop");
  console.log(`sweepEth ${txUrl(cfg, r.hash)} (${formatEther(r.amount)} ETH to ${sink})`);
  console.log(`left on the one-time address: ${formatEther(await pub.getBalance({ address: dest.address }))} ETH (fee-budget dust)`);
  process.exit(0);
}

// 2. payer: USDC + gas drop
const paid = await payOneTime({ account: agent, destination: dest.address, amount, cfg });
console.log(`pay      ${txUrl(cfg, paid.transferHash)}`);
if (paid.gasDropHash) console.log(`gas drop ${txUrl(cfg, paid.gasDropHash)}`);

// 3. spend part of it privately: only the one-time key signs
const friend = privateKeyToAccount(generatePrivateKey()).address;
const half = amount / 2n;
const sent = await sendFromPrivate({ stealthKeys: keys, to: friend, amount: half, cfg });
for (const l of sent.legs) console.log(`send     ${txUrl(cfg, l.hash)} (${formatUnits(l.amount, 6)} USDC from ${l.from} to ${friend})`);

// 4. sweep the rest + leftover ETH
const sink = privateKeyToAccount(generatePrivateKey()).address;
const sw = await sweepOneTime({ stealthKeys: keys, destination: dest.address, to: sink, cfg });
console.log(`sweep    ${txUrl(cfg, sw.hash)} (${formatUnits(sw.amount, 6)} USDC to ${sink})`);
if (sw.eth) console.log(`sweepEth ${txUrl(cfg, sw.eth.hash)} (${formatEther(sw.eth.amount)} ETH)`);
else console.log(`sweepEth skipped: ${sw.ethError ?? "only dust left"}`);
const dust = await pub.getBalance({ address: dest.address });
console.log(`left on the one-time address: ${formatEther(dust)} ETH (fee-budget dust)`);
