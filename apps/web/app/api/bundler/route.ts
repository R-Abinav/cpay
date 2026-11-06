// POST /api/bundler: JSON-RPC pass-through to the Pimlico ERC-4337 bundler for the phone's Railgun
// client. The Pimlico key stays on the server. Logs nothing. See lib/server/bundler.ts.
import { handleBundler } from "../../../lib/server/bundler.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleBundler(req, {
    apiKey: process.env.PIMLICO_API_KEY,
    chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID || "11155111"),
  });
}
