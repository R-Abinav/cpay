"use client";
// "I already have a CPay wallet": brings the same keys back from the user's existing passkey on this domain,
// when this browser's storage no longer has the wallet (cleared data, another browser, the home-screen app).
// `auto`: in the installed app (standalone), ask for the passkey once on open: whoever installed CPay to the home
// screen almost always made the wallet already, so they go straight in instead of seeing "create passkey" again.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { errText, toast } from "../lib/toast.js";
import { hasWallet, restoreWallet } from "../lib/wallet.js";

const TRIED = "cpay.autoRestoreTried";

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function RestoreWallet({
  className = "",
  to = "/",
  auto = false,
  primary = false,
}: {
  className?: string;
  to?: string;
  auto?: boolean;
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const started = useRef(false);

  async function go(silent: boolean) {
    setBusy(true);
    try {
      const x = await restoreWallet();
      toast.success(`Welcome back · ${x.address.slice(0, 6)}…${x.address.slice(-4)}`);
      router.replace(to);
    } catch (e) {
      // Auto attempt: a cancel or "no passkey here" just leaves the normal screen in place.
      if (!silent) toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!auto || started.current || !isStandalone()) return;
    started.current = true;
    try {
      if (sessionStorage.getItem(TRIED)) return; // once per app open
      sessionStorage.setItem(TRIED, "1");
    } catch {
      // no sessionStorage: still try once (guarded by the ref)
    }
    // Only when this browser really has no wallet (otherwise "/" just unlocks the stored one).
    void hasWallet().then((has) => (has ? router.replace(to) : go(true)), () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void go(false)}
      className={`flex w-full items-center justify-center rounded-2xl font-semibold disabled:opacity-60 ${
        primary ? "min-h-14 bg-emerald-500 text-lg text-black" : "min-h-12 border border-neutral-800"
      } ${className}`}
    >
      {busy ? "Waiting for your passkey…" : primary ? "Continue with my passkey" : "I already have a wallet · use my passkey"}
    </button>
  );
}
