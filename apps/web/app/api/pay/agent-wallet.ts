import "server-only";
// THE ONLY CODE THAT READS AGENT_WALLET_PRIVATE_KEY. Imported only by app/api/pay/route.ts.
// The key never leaves this module: not returned, not logged, not sent to 0G or the browser.
import { createPublicClient, erc20Abi, http, type Account, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { NotConfigured } from "../../../lib/server/config.js";

export function agentAccount(): Account {
  const k = (process.env.AGENT_WALLET_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new NotConfigured(["AGENT_WALLET_PRIVATE_KEY"]);
  return privateKeyToAccount(k as `0x${string}`);
}

export interface Balances {
  token: bigint | null;
  eth: bigint | null;
}

/** Read balances; a failed read is null (the policy then fails closed). */
export async function agentBalances(rpcUrl: string, address: Address, token: Address): Promise<Balances> {
  const pub = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 8000 }) });
  const [t, e] = await Promise.allSettled([
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    pub.getBalance({ address }),
  ]);
  return { token: t.status === "fulfilled" ? t.value : null, eth: e.status === "fulfilled" ? e.value : null };
}
