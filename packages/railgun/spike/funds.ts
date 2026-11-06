// Prints the dev wallet ADDRESS and its Sepolia ETH/USDC balances. Never prints the key.
import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readEnv } from "./common.js";

export const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const rpc = readEnv("SEPOLIA_RPC_URL") || readEnv("NEXT_PUBLIC_SEPOLIA_RPC_URL");
const pk = readEnv("AGENT_WALLET_PRIVATE_KEY") as `0x${string}`;
const account = privateKeyToAccount(pk);
const client = createPublicClient({ chain: sepolia, transport: http(rpc) });
const [eth, usdc, chainId] = await Promise.all([
  client.getBalance({ address: account.address }),
  client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  client.getChainId(),
]);
console.log({ chainId, address: account.address, eth: formatEther(eth), usdc: formatUnits(usdc, 6) });
