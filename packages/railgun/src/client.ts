// The real Railgun client on @kohaku-eth/railgun 0.0.1-alpha.31. Runs on the phone: the seed, the
// 0zk keys and every proof stay in this process. Payments leave through an ERC-4337 UserOperation
// (our bundler proxy -> Pimlico, gas sponsored by the Railgun privacy paymaster, fee paid from the
// SHIELDED WETH balance), sent from a fresh, never-funded EIP-7702 account per payment. No wallet of
// ours signs or pays gas for the unshield, and there is no fallback path.
import { MnemonicKeystore } from "@kohaku-eth/plugins";
import type { Host, Storage } from "@kohaku-eth/plugins";
import { viem as viemProvider } from "@kohaku-eth/provider/viem";
import {
  Bundler,
  RailgunSigner,
  Signer,
  SimpleSmartAccount,
  buildUnshieldExecutionCalls,
  chainConfig,
  createRailgunPlugin,
  ensureInitialized,
  type RailgunPlugin,
  type RailgunProvider,
} from "@kohaku-eth/railgun";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { installArtifactFetch } from "./artifacts.js";
import { eip1193Of } from "./eip1193.js";
import { canPayFrom, privateNeeds } from "./needs.js";
import { dedupeNotes, rewindTail } from "./tail.js";
import type { PrivateBalances, RailgunClient, RailgunConfig, TxData } from "./types.js";

/** How far back every (re)build rescans, in blocks (~10 min on Sepolia). */
export const TAIL_BLOCKS = 50;
/** sync() rebuilds the provider (and so rescans the tail) at most this often. */
const TAIL_REBUILD_MS = 60_000;
const wethAbi = parseAbi(["function deposit() payable"]);

type Internals = { provider: RailgunProvider; pool: { primary: RailgunSigner } };

function absolute(url: string): string {
  const loc = (globalThis as { location?: { href: string } }).location;
  return new URL(url, loc?.href).href;
}

/** Serialises every call: the WASM provider is not re-entrant. */
function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Reads a field from a WASM-returned value (plain object or Map; camelCase or snake_case). */
function get(v: unknown, key: string): unknown {
  if (v == null || typeof v !== "object") return undefined;
  const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  if (v instanceof Map) return v.has(key) ? v.get(key) : v.get(snake);
  const o = v as Record<string, unknown>;
  return key in o ? o[key] : o[snake];
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

function txHashOf(receipt: unknown): Hex | null {
  const h = get(get(receipt, "receipt"), "transactionHash");
  return typeof h === "string" && HASH.test(h) ? (h as Hex) : null;
}

/**
 * Standard ERC-4337 eth_getUserOperationReceipt through our proxy (same request Kohaku makes).
 * "pending" = not included yet or the bundler/proxy was unreachable (ask again); "reverted" = included, failed.
 */
async function receiptOnce(bundlerUrl: string, userOpHash: string): Promise<Hex | "pending" | "reverted"> {
  try {
    const res = await fetch(bundlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: [userOpHash] }),
    });
    if (!res.ok) return "pending";
    const j = (await res.json()) as { result?: { success?: boolean; receipt?: { transactionHash?: string } } | null };
    if (!j.result) return "pending";
    if (j.result.success !== true) return "reverted";
    const h = j.result.receipt?.transactionHash;
    return typeof h === "string" && HASH.test(h) ? (h as Hex) : "pending";
  } catch {
    return "pending";
  }
}

/** Polls for the receipt of an already-SENT UserOperation, so a flaky bundler link never reports a sent payment as failed. */
async function pollReceipt(bundlerUrl: string, userOpHash: string, ms = 180_000): Promise<Hex> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await receiptOnce(bundlerUrl, userOpHash);
    if (r === "reverted") throw new Error("railgun: UserOperation reverted");
    if (r !== "pending") return r;
    if (Date.now() > end) throw new Error(`railgun: payment sent (UserOperation ${userOpHash}) but no receipt yet; check the explorer before retrying`);
    await new Promise((ok) => setTimeout(ok, 4_000));
  }
}

function asStorage(s: RailgunConfig["storage"]): Storage {
  return { _brand: "Storage", get: (k) => s.get(k), set: (k, v) => s.set(k, v) };
}

export async function initRailgun(cfg: RailgunConfig): Promise<RailgunClient> {
  if (!(cfg.seed instanceof Uint8Array) || cfg.seed.length !== 32) throw new Error("railgun: seed must be 32 bytes");
  if (!isAddress(cfg.usdc) || !isAddress(cfg.weth)) throw new Error("railgun: bad token address");
  installArtifactFetch(cfg.artifactsBase);
  const wasm = await fetch(absolute(cfg.wasmUrl));
  if (!wasm.ok) throw new Error(`railgun: WASM not found on our origin (${wasm.status})`);
  await ensureInitialized(wasm, "Off");

  const rg = chainConfig(BigInt(cfg.chainId));
  if (!rg) throw new Error(`railgun: chain ${cfg.chainId} not supported`);
  const usdc = cfg.usdc.toLowerCase() as Hex;
  const weth = cfg.weth.toLowerCase() as Hex;
  if (weth !== rg.wrappedBaseToken.toLowerCase()) throw new Error("railgun: weth must be the chain's wrapped base token");

  const client = createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 30_000 }) }) as PublicClient;
  const rpcChain = await client.getChainId();
  if (rpcChain !== cfg.chainId) throw new Error(`railgun: RPC is chain ${rpcChain}, expected ${cfg.chainId}`);

  const keystore = new MnemonicKeystore(entropyToMnemonic(cfg.seed, wordlist));
  const self = RailgunSigner.privateKey(
    await keystore.deriveAt(RailgunSigner.spendingKeyPath(0)),
    await keystore.deriveAt(RailgunSigner.viewingKeyPath(0)),
    BigInt(cfg.chainId),
  ).address;
  const storage = asStorage(cfg.storage);
  const host: Host = {
    network: { fetch: (i, init) => globalThis.fetch(i, init) },
    storage,
    keystore,
    provider: viemProvider(client as never),
  };
  const bundler = Bundler.pimlico(absolute(cfg.bundlerUrl));
  const aaProvider = eip1193Of(client);

  // Build (or rebuild) the provider from storage, optionally after rewinding the tail.
  let plugin!: RailgunPlugin;
  let builtAt = 0;
  let rewound = false;
  async function build(rescan: boolean): Promise<void> {
    if (rescan) await rewindTail(cfg.storage, cfg.chainId, self, TAIL_BLOCKS, rg!.deploymentBlock);
    plugin = await createRailgunPlugin(host, { rpcBatchSize: 10, logLevel: "Off" });
    builtAt = Date.now();
    rewound = rescan;
    if ((await plugin.instanceId()) !== self) throw new Error("railgun: address mismatch");
  }
  /** Incremental sync; every TAIL_REBUILD_MS it rebuilds with a tail rescan, then drops replayed duplicates. */
  async function syncNow(): Promise<void> {
    if (Date.now() - builtAt >= TAIL_REBUILD_MS) await build(true);
    await inner().provider.sync();
    if (rewound) {
      rewound = false;
      if (await dedupeNotes(cfg.storage, cfg.chainId, self)) await build(false);
    }
  }
  const inner = () => plugin as unknown as Internals;
  const run = queue();
  await run(() => build(true));

  async function balancesNow(): Promise<PrivateBalances> {
    const out: PrivateBalances = { usdc: { valid: 0n, pending: 0n }, weth: { valid: 0n, pending: 0n } };
    for (const b of await inner().provider.balance(self)) {
      if (b.asset.type !== "Erc20" || b.amount <= 0n) continue;
      const a = b.asset.value.toLowerCase();
      const slot = a === usdc ? out.usdc : a === weth ? out.weth : null;
      if (!slot) continue;
      // Without POI (never in CPay) poiStatus is undefined; anything but "Valid" is not spendable.
      if (b.poiStatus === "Valid") slot.valid += b.amount;
      else slot.pending += b.amount;
    }
    return out;
  }

  return {
    address: () => self,

    sync: () =>
      run(async () => {
        await syncNow();
      }),

    balances: () => run(balancesNow),

    async prepareShield({ token, amount, from }): Promise<TxData[]> {
      if (amount <= 0n) throw new Error("railgun: amount must be positive");
      if (!isAddress(from)) throw new Error("railgun: bad sender");
      const contract = token === "USDC" ? usdc : token === "WETH" ? weth : null;
      if (!contract) throw new Error("railgun: token must be USDC or WETH");
      const txs: TxData[] = [];
      if (token === "WETH") {
        const have = await client.readContract({ address: weth, abi: erc20Abi, functionName: "balanceOf", args: [from] });
        if (have < amount) {
          txs.push({ to: weth, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: amount - have });
        }
      }
      const shield = await run(() => plugin.prepareShield({ asset: { __type: "erc20", contract }, amount }));
      if (shield.length !== 1) throw new Error("railgun: unexpected shield shape");
      const s = shield[0]!;
      if (s.to.toLowerCase() !== rg.railgunSmartWallet.toLowerCase()) throw new Error("railgun: shield target is not the Railgun contract");
      const allowance = await client.readContract({ address: contract, abi: erc20Abi, functionName: "allowance", args: [from, s.to as Hex] });
      if (allowance < amount) {
        txs.push({ to: contract, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.to as Hex, amount] }), value: 0n });
      }
      txs.push({ to: s.to as Hex, data: s.data as Hex, value: BigInt(s.value) });
      return txs;
    },

    canPay: (p) => run(async () => canPayFrom(await balancesNow(), privateNeeds(p))),

    pay: ({ amount, to, gasDropWei = 0n, onStage }) =>
      run(async () => {
        if (amount <= 0n) throw new Error("railgun: amount must be positive");
        if (gasDropWei < 0n) throw new Error("railgun: bad gas drop");
        if (!isAddress(to)) throw new Error("railgun: bad destination");
        await syncNow();
        const can = canPayFrom(await balancesNow(), privateNeeds({ amount, gasDropWei, feeBps: rg.unshieldFeeBps }));
        if (!can.ok) {
          throw new Error(
            can.reason === "usdc"
              ? "railgun: not enough spendable (POI-valid) private USDC"
              : "railgun: not enough spendable private WETH for the paymaster fee and gas drop",
          );
        }

        // Fresh 7702 account per payment: never funded, never reused, key dropped after signing.
        const aa = Signer.privateKey(generatePrivateKey());
        const account = new SimpleSmartAccount(aa.address, BigInt(cfg.chainId), aaProvider);
        // Notes are chosen by Kohaku from POI-"Valid" balances only.
        let op: Awaited<ReturnType<RailgunPlugin["prepareUnshield"]>>;
        let calls: ReturnType<typeof buildUnshieldExecutionCalls>;
        if (gasDropWei === 0n) {
          // USDC straight to the destination.
          op = await plugin.prepareUnshield({ asset: { __type: "erc20", contract: usdc }, amount }, to);
          calls = buildUnshieldExecutionCalls({ wrappedBaseToken: rg.wrappedBaseToken, nativeAmount: op.nativeAmount, to: op.to });
        } else {
          // USDC + gas-drop WETH to the fresh account, which (same UserOperation) unwraps the WETH and forwards
          // both to the destination. The ETH comes from the shielded balance: no public wallet funds it.
          op = await plugin.prepareUnshieldMulti(
            [
              { asset: { __type: "erc20", contract: usdc }, amount },
              { asset: { __type: "native" }, amount: gasDropWei },
            ],
            aa.address as Hex,
          );
          if (op.nativeAmount !== gasDropWei || op.to?.toLowerCase() !== aa.address.toLowerCase()) throw new Error("railgun: unexpected unshield shape");
          calls = buildUnshieldExecutionCalls({
            wrappedBaseToken: rg.wrappedBaseToken,
            nativeAmount: gasDropWei,
            to: aa.address as Hex,
            userTailCalls: [
              { target: usdc, value: "0x0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) },
              { target: to, value: toHex(gasDropWei), data: "0x" },
            ],
          });
        }

        onStage?.("proving");
        const signable = await inner().provider.prepareUserOp(op.builder, bundler, account, inner().pool.primary, rg.wrappedBaseToken, calls);
        const signed = await signable.sign(aa);
        onStage?.("submitting");
        const userOpHash = await bundler.sendUserOperation(signed);
        onStage?.("confirming");
        // Sent: from here on never report "failed" just because the bundler link is flaky.
        let txHash: Hex | null = null;
        try {
          const receipt = await bundler.waitForReceipt(userOpHash);
          if (get(receipt, "success") === false) throw new Error("railgun: UserOperation reverted");
          txHash = get(receipt, "success") === true ? txHashOf(receipt) : null;
        } catch (e) {
          if (e instanceof Error && e.message === "railgun: UserOperation reverted") throw e;
        }
        txHash ??= await pollReceipt(absolute(cfg.bundlerUrl), userOpHash);
        const onchain = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
        if (onchain.status !== "success") throw new Error("railgun: transaction reverted");
        await inner().provider.sync();
        return { txHash };
      }),
  };
}
