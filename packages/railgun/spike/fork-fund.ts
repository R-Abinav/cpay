// LOCAL ANVIL FORK ONLY: give the dev wallet fork-ETH and fork-USDC so the prover can be timed
// without real funds. Nothing here touches the real chain.
import { createTestClient, encodeAbiParameters, erc20Abi, formatUnits, http, keccak256, publicActions, toHex } from "viem";
import { sepolia } from "viem/chains";

const FORK = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const DEV = "0xfF1f248b90c519B2BE8811ae649E941738204C86" as const;
const t = createTestClient({ chain: sepolia, mode: "anvil", transport: http(FORK) }).extend(publicActions);

await t.setBalance({ address: DEV, value: 10n ** 20n });
// FiatTokenV2_2: balanceAndBlacklistStates mapping at slot 9.
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [DEV, 9n]));
await t.setStorageAt({ address: USDC, index: slot, value: toHex(100_000_000n, { size: 32 }) });
const bal = await t.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [DEV] });
console.log("fork USDC:", formatUnits(bal, 6), "fork block:", await t.getBlockNumber());
