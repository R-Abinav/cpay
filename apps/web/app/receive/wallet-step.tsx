"use client";
// Step 1: derive stealth keys from ONE wallet signature over KEY_DERIVATION_MESSAGE (recoverable from the wallet).
// The keys stay in the encrypted on-device vault; the meta-address is never shared with anyone.
import { useState } from "react";
import { KEY_DERIVATION_MESSAGE, keysFromSignature, type StealthKeys } from "@cpay/stealth";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { Button, ErrorNote, NotConnected, Section } from "../../components/ui.js";
import { errorMessage } from "../../lib/deps.js";
import { VAULT, vaultSet } from "../../lib/vault.js";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function WalletStep({ keys, onKeys }: { keys: StealthKeys | null; onKeys: (k: StealthKeys) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasWallet = typeof window !== "undefined" && !!window.ethereum;

  async function derive() {
    setErr(null);
    setBusy(true);
    try {
      const wallet = createWalletClient({ transport: custom(window.ethereum!) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("no account selected");
      const sig = await wallet.signMessage({ account, message: KEY_DERIVATION_MESSAGE });
      const k = keysFromSignature(sig);
      await vaultSet(VAULT.stealthKeys, k);
      onKeys(k);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section step={1} title="Receiving keys" done={!!keys}>
      {keys ? (
        <p className="text-sm text-neutral-400">Stealth keys derived and stored encrypted on this phone. Each payment goes to a fresh one-time address only this phone can spend.</p>
      ) : !hasWallet ? (
        <NotConnected id="injected-wallet" detail="No EIP-1193 wallet in this browser. Open this page in your wallet's in-app browser (e.g. MetaMask mobile)." />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-neutral-400">Sign one message with your wallet. The signature derives your receiving keys; it is never sent anywhere.</p>
          <details className="text-xs text-neutral-500">
            <summary>Message you will sign</summary>
            <pre className="mt-2 whitespace-pre-wrap">{KEY_DERIVATION_MESSAGE}</pre>
          </details>
          <Button onClick={derive} disabled={busy} className="w-full">
            {busy ? "Waiting for wallet…" : "Sign to derive keys"}
          </Button>
        </div>
      )}
      {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
    </Section>
  );
}
