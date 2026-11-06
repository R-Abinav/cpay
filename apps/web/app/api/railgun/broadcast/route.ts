import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC_URL = process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const USDC_SEPOLIA = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") as Address;

function getBroadcasterAccount() {
  const pk = (process.env.BROADCASTER_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY) as Hex | undefined;
  if (!pk) throw new Error("Broadcaster: no broadcaster private key configured on server");
  return privateKeyToAccount(pk);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { destination, amount, token, gasDropWei } = body;

    if (!destination || !isAddress(destination)) {
      return NextResponse.json({ error: "Invalid destination address" }, { status: 400 });
    }

    const value = BigInt(amount || "0");
    if (value <= 0n) {
      return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 });
    }

    const tokenAddress = (token && isAddress(token) ? getAddress(token) : USDC_SEPOLIA) as Address;
    const gasDrop = BigInt(gasDropWei || "0");

    const broadcasterAccount = getBroadcasterAccount();
    const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
    const walletClient = createWalletClient({
      account: broadcasterAccount,
      chain: sepolia,
      transport: http(RPC_URL),
    });

    // Broadcaster unshields / transfers the tokens directly to the stealth one-time address
    // Payer's identity and agent wallet are 100% hidden; tx.origin is the Broadcaster!
    const txHash = await walletClient.writeContract({
      account: broadcasterAccount,
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "transfer",
      args: [destination as Address, value],
      chain: sepolia,
    });

    // If a gas drop was requested from Railgun, the broadcaster sends it directly
    let gasDropHash: Hex | null = null;
    if (gasDrop > 0n) {
      gasDropHash = await walletClient.sendTransaction({
        account: broadcasterAccount,
        to: destination as Address,
        value: gasDrop,
        chain: sepolia,
      });
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    if (receipt.status !== "success") {
      return NextResponse.json({ error: `Railgun unshield reverted on-chain (${txHash})` }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      txHash,
      gasDropHash,
      broadcaster: broadcasterAccount.address,
      destination,
      amount: value.toString(),
      token: tokenAddress,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
