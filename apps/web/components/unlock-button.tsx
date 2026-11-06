"use client";
// The one "Unlock with passkey" button: shows "Unlocking…" while the passkey sheet is open so a tap always
// visibly registers, ignores double taps, and turns a failure (cancel, wrong passkey, no PRF) into a toast.
import { useState } from "react";
import { errText, toast } from "../lib/toast.js";
import { unlockWallet } from "../lib/wallet.js";

const BASE = "min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-50";

export function UnlockButton({ disabled = false, className = BASE }: { disabled?: boolean; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-busy={busy}
      className={className}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        unlockWallet()
          .catch((e) => toast.error(errText(e)))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Unlocking…" : "Unlock with passkey"}
    </button>
  );
}
