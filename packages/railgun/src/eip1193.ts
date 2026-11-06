// The WASM-facing Eip1193Provider for SimpleSmartAccount, over a viem PublicClient. Mirrors
// Kohaku's own (unexported) EthereumProviderAdapter.
import type { Eip1193Provider, RawLog } from "@kohaku-eth/railgun";
import { numberToHex, type Hex, type PublicClient } from "viem";

export function eip1193Of(client: PublicClient): Eip1193Provider {
  return {
    getChainId: async () => BigInt(await client.getChainId()),
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getLogs(address, eventSignature, fromBlock, toBlock) {
      const filter: Record<string, unknown> = { address };
      if (fromBlock !== undefined) filter.fromBlock = numberToHex(fromBlock);
      if (toBlock !== undefined) filter.toBlock = numberToHex(toBlock);
      if (eventSignature) filter.topics = [eventSignature];
      const logs = (await client.request({ method: "eth_getLogs", params: [filter as never] })) as {
        blockNumber: Hex | null;
        transactionHash: Hex | null;
        address: Hex;
        topics: Hex[];
        data: Hex;
      }[];
      return logs.map(
        (l): RawLog => ({
          blockNumber: l.blockNumber != null ? Number(BigInt(l.blockNumber)) : null,
          blockTimestamp: null,
          transactionHash: l.transactionHash,
          address: l.address ?? address,
          topics: l.topics ?? [],
          data: l.data ?? "0x",
        }),
      );
    },
    async ethCall(to, data) {
      const r = await client.call({ to, data });
      return r.data ?? "0x";
    },
    estimateGas: (to, from, data) => client.estimateGas({ to, account: from, data }),
    getGasPrice: () => client.getGasPrice(),
    async getTransactionCount(address, block) {
      const n = await client.getTransactionCount(
        block === undefined ? { address } : { address, blockNumber: BigInt(block) },
      );
      return BigInt(n);
    },
  };
}
