// Test fixture only: an in-memory EVM JSON-RPC (one ERC-20 + ETH balances) behind a viem custom transport.
// It decodes and recovers every signed raw transaction, so tests see exactly what the phone signed.
import { ANNOUNCER_ABI, ERC5564_ANNOUNCER } from "@cpay/stealth";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";

export interface SentTx {
  from: Address;
  to: Address;
  value: bigint;
  /** decoded ERC-20 transfer, if any */
  transfer?: { token: Address; to: Address; amount: bigint };
  /** decoded ERC5564Announcer.announce, if any */
  announce?: { schemeId: bigint; stealthAddress: Address; ephemeralPubKey: Hex; metadata: Hex };
  hash: Hex;
  chainId: number;
}

export function fakeChain(opts: { chainId: number; token: Address }) {
  const eth = new Map<string, bigint>();
  const tok = new Map<string, bigint>();
  const nonces = new Map<string, number>();
  const sent: SentTx[] = [];
  const receipts = new Map<string, { status: Hex; blockNumber: Hex }>();
  const logs: { block: bigint; topics: Hex[]; data: Hex; hash: Hex }[] = [];
  const getLogsCalls: { fromBlock: bigint; toBlock: bigint }[] = [];
  let block = 100n;
  let revertNext = false;
  const k = (a: string) => a.toLowerCase();

  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_chainId":
          return toHex(opts.chainId);
        case "eth_blockNumber":
          return toHex(block);
        case "eth_getBlockByNumber":
          return { number: toHex(block), hash: keccak256(toHex(block)), baseFeePerGas: "0x1", timestamp: "0x1", transactions: [] };
        case "eth_maxPriorityFeePerGas":
          return "0x1";
        case "eth_gasPrice":
          return "0x2";
        case "eth_estimateGas":
          return "0x186a0";
        case "eth_getTransactionCount": {
          const a = p[0] as string;
          return toHex(nonces.get(k(a)) ?? 0);
        }
        case "eth_getBalance":
          return toHex(eth.get(k(p[0] as string)) ?? 0n);
        case "eth_call": {
          const call = p[0] as { to: string; data: Hex };
          if (k(call.to) !== k(opts.token)) throw new Error("fakechain: unknown contract");
          const d = decodeFunctionData({ abi: erc20Abi, data: call.data });
          if (d.functionName !== "balanceOf") throw new Error("fakechain: unsupported call");
          const who = d.args[0] as string;
          return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: tok.get(k(who)) ?? 0n });
        }
        case "eth_sendRawTransaction": {
          const raw = p[0] as TransactionSerialized;
          const tx = parseTransaction(raw);
          const from = await recoverTransactionAddress({ serializedTransaction: raw });
          const hash = keccak256(raw);
          nonces.set(k(from), (nonces.get(k(from)) ?? 0) + 1);
          const s: SentTx = { from, to: getAddress(tx.to!), value: tx.value ?? 0n, hash, chainId: tx.chainId! };
          let ok = !revertNext;
          revertNext = false;
          if (tx.data && tx.data !== "0x" && k(s.to) === k(ERC5564_ANNOUNCER)) {
            // ERC5564Announcer.announce -> one Announcement log (caller = signer)
            const d = decodeFunctionData({ abi: ANNOUNCER_ABI, data: tx.data });
            if (d.functionName !== "announce") throw new Error("fakechain: unsupported announcer call");
            const [schemeId, stealthAddress, ephemeralPubKey, metadata] = d.args;
            s.announce = { schemeId, stealthAddress: getAddress(stealthAddress), ephemeralPubKey, metadata };
            if (ok) {
              logs.push({
                block: block + 1n,
                topics: encodeEventTopics({ abi: ANNOUNCER_ABI, eventName: "Announcement", args: { schemeId, stealthAddress, caller: from } }) as Hex[],
                data: encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [ephemeralPubKey, metadata]),
                hash,
              });
            }
          } else if (tx.data && tx.data !== "0x") {
            const d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
            if (d.functionName !== "transfer") throw new Error("fakechain: unsupported tx");
            const [to, amount] = d.args as [Address, bigint];
            s.transfer = { token: s.to, to: getAddress(to), amount };
            const bal = tok.get(k(from)) ?? 0n;
            if (k(s.to) !== k(opts.token) || bal < amount) ok = false;
            if (ok) {
              tok.set(k(from), bal - amount);
              tok.set(k(to), (tok.get(k(to)) ?? 0n) + amount);
            }
          }
          if (ok && s.value > 0n) {
            eth.set(k(from), (eth.get(k(from)) ?? 0n) - s.value);
            eth.set(k(s.to), (eth.get(k(s.to)) ?? 0n) + s.value);
          }
          sent.push(s);
          block += 1n;
          receipts.set(hash, { status: ok ? "0x1" : "0x0", blockNumber: toHex(block) });
          return hash;
        }
        case "eth_getTransactionReceipt": {
          const r = receipts.get(p[0] as string);
          if (!r) return null;
          return {
            ...r,
            transactionHash: p[0],
            blockHash: keccak256(r.blockNumber),
            transactionIndex: "0x0",
            logs: [],
            gasUsed: "0x5208",
            cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            type: "0x2",
          };
        }
        case "eth_getLogs": {
          const f = p[0] as { address?: string; fromBlock: Hex; toBlock: Hex; topics?: (Hex | null)[] };
          getLogsCalls.push({ fromBlock: BigInt(f.fromBlock), toBlock: BigInt(f.toBlock) });
          if (f.address && k(f.address) !== k(ERC5564_ANNOUNCER)) return [];
          return logs
            .filter((l) => l.block >= BigInt(f.fromBlock) && l.block <= BigInt(f.toBlock))
            .filter((l) => (f.topics ?? []).every((t, i) => t === null || t === undefined || k(t) === k(l.topics[i] ?? "")))
            .map((l, i) => ({
              address: ERC5564_ANNOUNCER,
              topics: l.topics,
              data: l.data,
              blockNumber: toHex(l.block),
              blockHash: keccak256(toHex(l.block)),
              transactionHash: l.hash,
              transactionIndex: "0x0",
              logIndex: toHex(i),
              removed: false,
            }));
        }
        default:
          throw new Error(`fakechain: ${method} not implemented`);
      }
    },
  });

  return {
    transport,
    sent,
    getLogsCalls,
    /** move the head forward (empty blocks) */
    mine: (n: bigint) => {
      block += n;
    },
    setEth: (a: Address, v: bigint) => eth.set(k(a), v),
    setToken: (a: Address, v: bigint) => tok.set(k(a), v),
    tokenOf: (a: Address) => tok.get(k(a)) ?? 0n,
    ethOf: (a: Address) => eth.get(k(a)) ?? 0n,
    revertNextTx: () => {
      revertNext = true;
    },
  };
}
