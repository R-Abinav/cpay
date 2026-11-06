import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_URL = process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const RAILGUN_PROXY = "0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea" as Address;

function getBroadcasterAccount() {
  const pk = process.env.BROADCASTER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("Broadcaster: no broadcaster private key configured on server");
  return privateKeyToAccount(pk);
}

const MAX_GAS_DROP_WEI = 1_000_000_000_000_000n; // 0.001 ETH
const BROADCASTS_PER_MINUTE = 4;
const rateWindows = new Map<string, { start: number; count: number }>();

function rateLimited(req: NextRequest): boolean {
  // Render's Cloudflare edge overwrites CF-Connecting-IP. Do not trust caller-controlled X-Forwarded-For.
  const ip = req.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const now = Date.now();
  if (rateWindows.size > 10_000) {
    for (const [key, value] of rateWindows) if (now - value.start >= 60_000) rateWindows.delete(key);
  }
  const window = rateWindows.get(ip);
  if (!window || now - window.start >= 60_000) {
    rateWindows.set(ip, { start: now, count: 1 });
    return false;
  }
  window.count += 1;
  return window.count > BROADCASTS_PER_MINUTE;
}

export async function POST(
  req: NextRequest,
  injectedClients?: { publicClient?: any; walletClient?: any }
) {
  try {
    if (rateLimited(req)) {
      return NextResponse.json({ error: "Broadcaster rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
    }
    const body = await req.json();
    const { destination, gasDropWei, transaction } = body;

    if (!destination || !isAddress(destination)) {
      return NextResponse.json({ error: "Invalid destination address" }, { status: 400 });
    }

    if (
      !transaction ||
      typeof transaction !== "object" ||
      !isAddress(transaction.to) || getAddress(transaction.to) !== getAddress(RAILGUN_PROXY) ||
      typeof transaction.data !== "string" || !/^0x(?:[\da-fA-F]{2})+$/.test(transaction.data) || transaction.data.length > 1_000_000 ||
      (transaction.value !== "0" && transaction.value !== 0 && transaction.value !== undefined)
    ) {
      return NextResponse.json({ error: "Invalid proved Railgun transaction" }, { status: 400 });
    }

    if (gasDropWei !== undefined && (typeof gasDropWei !== "string" || !/^(0|[1-9]\d*)$/.test(gasDropWei))) {
      return NextResponse.json({ error: "gasDropWei must be a non-negative integer string" }, { status: 400 });
    }
    const gasDrop = BigInt(gasDropWei || "0");
    if (gasDrop > MAX_GAS_DROP_WEI) {
      return NextResponse.json({ error: "gasDropWei exceeds the 0.001 ETH limit" }, { status: 400 });
    }

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
      to: getAddress(transaction.to),
      data: transaction.data,
      value: 0n,
      chain: sepolia,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    if (receipt.status !== "success") {
      return NextResponse.json({ error: `Railgun unshield reverted on-chain (${txHash})` }, { status: 500 });
    }

    // 3. If a gas drop was requested from Railgun broadcaster, send it to the destination
    let gasDropHash: Hex | null = null;
    let gasDropError: string | null = null;
    if (gasDrop > 0n) {
      // Only fund the recipient actually emitted by Railgun's successful unshield receipt.
      // A mismatched request must never redirect broadcaster funds.
      const unshieldRecipients = (receipt.logs ?? []).flatMap((log: { address: Address; data: Hex; topics: readonly Hex[] }) => {
        if (getAddress(log.address) !== getAddress(RAILGUN_PROXY)) return [];
        try {
          const event = decodeEventLog({ abi: [{
            type: "event", name: "Unshield", anonymous: false,
            inputs: [
              { indexed: false, name: "to", type: "address" },
              { indexed: false, name: "token", type: "tuple", components: [
                { name: "tokenType", type: "uint8" }, { name: "tokenAddress", type: "address" }, { name: "tokenSubID", type: "uint256" },
              ] },
              { indexed: false, name: "amount", type: "uint256" },
              { indexed: false, name: "fee", type: "uint256" },
            ],
          }] as const, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
          return [event.args.to];
        } catch {
          return [];
        }
      });
      if (!unshieldRecipients.some((to: Address) => getAddress(to) === getAddress(destination))) {
        gasDropError = "Gas drop skipped because the requested destination does not match the Railgun unshield recipient";
      } else {
        try {
          gasDropHash = await walletClient.sendTransaction({
            account: broadcasterAccount,
            to: destination as Address,
            value: gasDrop,
            chain: sepolia,
          });
        } catch (error) {
          gasDropError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    return NextResponse.json({
      success: true,
      txHash,
      gasDropHash,
      gasDropError,
      broadcaster: broadcasterAccount.address,
      destination,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
