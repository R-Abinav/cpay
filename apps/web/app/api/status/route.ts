// GET /api/status: which server-side dependencies are wired + configured. No network calls to 0G here
// (a status poll must not spend credits); a dependency is "ok" when its package is implemented and configured.
import { initCredential } from "@cpay/credential";
import { approvalPublicKeyHex } from "@cpay/world";
import { replyText } from "@cpay/zerog";
import type { DependencyStatus } from "../../../lib/deps.js";
import { errorMessage, isNotImplemented } from "../../../lib/deps.js";
import { agentPassConfig, chainConfig, issuerPublicKey, routerOptions, storageOptions } from "../../../lib/server/config.js";

export const runtime = "nodejs";

async function probe(id: DependencyStatus["id"], fn: () => unknown | Promise<unknown>, okDetail: string): Promise<DependencyStatus> {
  try {
    await fn();
    return { id, state: "ok", detail: okDetail };
  } catch (e) {
    if (isNotImplemented(e)) return { id, state: "not_connected", detail: "package not implemented yet" };
    return { id, state: e instanceof Error && e.name === "NotConfigured" ? "not_connected" : "offline", detail: errorMessage(e) };
  }
}

export async function GET(): Promise<Response> {
  const deps = await Promise.all([
    probe("zerog", () => {
      routerOptions();
      replyText("ack", { amount: "1", token: "USDC" });
    }, "router configured, package wired"),
    probe("zerog-storage", () => storageOptions(), "storage configured"),
    probe("credential", () => initCredential(), "BBS WASM loaded"),
    probe("agent-pass", () => {
      // The phone verifies approval tokens with the public key it was built with: they must match.
      const pk = approvalPublicKeyHex(agentPassConfig().approvalSecretKey);
      const pub = (process.env.NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY ?? "").trim().toLowerCase().replace(/^0x/, "");
      if (pub !== pk) throw new Error("NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY does not match the approval secret key");
    }, "OIDC client + approval key configured"),
    probe("issuer", () => issuerPublicKey(), "issuer key available"),
    probe("chain", () => chainConfig(), "RPC configured"),
  ]);
  return Response.json({ deps }, { headers: { "Cache-Control": "no-store" } });
}
