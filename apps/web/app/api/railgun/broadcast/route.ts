import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { proveAndPopulateUnshield } from "../../../../lib/railgun-server.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_URL = process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const USDC_SEPOLIA = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") as Address;

function getBroadcasterAccount() {
  const pk = (process.env.BROADCASTER_PRIVATE_KEY || process.env.AGENT_WALLET_PRIVATE_KEY) as Hex | undefined;
  if (!pk) throw new Error("Broadcaster: no broadcaster private key configured on server");
  return privateKeyToAccount(pk);
}

export async function POST(
  req: NextRequest,
  injectedClients?: { publicClient?: any; walletClient?: any }
) {
  try {
    const body = await req.json();
    const { destination, amount, token, gasDropWei, mnemonic } = body;

    if (!destination || !isAddress(destination)) {
      return NextResponse.json({ error: "Invalid destination address" }, { status: 400 });
    }

    const value = BigInt(amount || "0");
    if (value <= 0n) {
      return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 });
    }

    if (!mnemonic || typeof mnemonic !== "string") {
      return NextResponse.json({ error: "Missing Railgun mnemonic for private unshield proof" }, { status: 400 });
    }

    const tokenAddress = (token && isAddress(token) ? getAddress(token) : USDC_SEPOLIA) as Address;
    const gasDrop = BigInt(gasDropWei || "0");

    // 1. Generate zk-SNARK unshield proof & populate official Railgun Smart Wallet transact call
    const { transaction } = await proveAndPopulateUnshield({
      mnemonic,
      destination: destination as Address,
      amount: value,
      tokenAddress,
    });

    const broadcasterAccount = getBroadcasterAccount();
    const publicClient = injectedClients?.publicClient || createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
    const walletClient = injectedClients?.walletClient || createWalletClient({
      account: broadcasterAccount,
      chain: sepolia,
      transport: http(RPC_URL),
    });

    // 2. Broadcaster submits the proved zk transaction directly to the official Railgun Proxy contract
    // Payer's public address NEVER appears on-chain; funds come from the communal Railgun zero-knowledge pool!
    const txHash = await walletClient.sendTransaction({
      account: broadcasterAccount,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      chain: sepolia,
    });

    // 3. If a gas drop was requested from Railgun broadcaster, send it to the destination
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
