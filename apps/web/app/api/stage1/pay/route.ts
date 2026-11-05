import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, erc20Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const runtime = "nodejs";

function getAgentPrivateKey(): string {
  let key = (process.env.AGENT_WALLET_PRIVATE_KEY || "").trim();
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) return key;

  // Fallback: directly read root .env or apps/web/.env if process.env was cached
  const envPaths = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../.env"),
  ];

  for (const p of envPaths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const match = content.match(/AGENT_WALLET_PRIVATE_KEY=["']?(0x[0-9a-fA-F]{64})["']?/);
        if (match && match[1]) {
          return match[1];
        }
      } catch {}
    }
  }
  return "";
}

// Circle USDC on Base Sepolia
const USDC_BASE_SEPOLIA_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address;

export async function POST(req: Request) {
  try {
    const { recipient, amount, token } = await req.json();

    if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      return NextResponse.json({ error: "Invalid recipient Ethereum address" }, { status: 400 });
    }

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    const privateKey = getAgentPrivateKey();
    if (!privateKey) {
      return NextResponse.json(
        {
          error: "AGENT_WALLET_PRIVATE_KEY not set in .env. Please configure an agent wallet or pay using browser MetaMask.",
          agentWalletConfigured: false,
        },
        { status: 400 }
      );
    }

    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL || "https://sepolia.base.org";
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl, { timeout: 15000 }),
    });

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl, { timeout: 15000 }),
    });

    let txHash: `0x${string}`;

    if (token?.toUpperCase() === "USDC") {
      // 6 decimals for Circle USDC
      const baseUnits = parseUnits(amount, 6);
      txHash = await walletClient.writeContract({
        address: USDC_BASE_SEPOLIA_ADDRESS,
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient as Address, baseUnits],
      });
    } else {
      // Default to Native Base Sepolia ETH
      const wei = parseEther(amount);
      txHash = await walletClient.sendTransaction({
        to: recipient as Address,
        value: wei,
      });
    }

    return NextResponse.json({
      success: true,
      txHash,
      from: account.address,
      to: recipient,
      amount,
      token: token || "ETH",
      network: "Base Sepolia",
      chainId: 84532,
      explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
    });
  } catch (err: any) {
    console.error("Agent Wallet Send Error:", err);
    return NextResponse.json({ error: err.message || "Failed to execute transaction" }, { status: 500 });
  }
}
