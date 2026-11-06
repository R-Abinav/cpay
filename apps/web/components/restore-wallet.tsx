"use client";
// "I already have a CPay wallet": brings the same keys back from the user's existing passkey on this domain,
// when this browser's storage no longer has the wallet (cleared data, another browser, the home-screen app).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errText, toast } from "../lib/toast.js";
import { restoreWallet } from "../lib/wallet.js";

export function RestoreWallet({ className = "", to = "/" }: { className?: string; to?: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const x = await restoreWallet();
          toast.success(`Wallet restored · ${x.address.slice(0, 6)}…${x.address.slice(-4)}`);
          router.replace(to);
        } catch (e) {
          toast.error(errText(e));
        } finally {
          setBusy(false);
        }
      }}
      className={`flex min-h-12 w-full items-center justify-center rounded-2xl border border-neutral-800 font-semibold disabled:opacity-60 ${className}`}
    >
      {busy ? "Waiting for your passkey…" : "I already have a wallet · use my passkey"}
    </button>
  );
}
