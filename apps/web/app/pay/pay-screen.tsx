"use client";
// Pay tab: one large stage, one action row, then a collapsed Details toggle. All transient feedback is a
// toast that appears in sync with the spoken reply (controller.say).
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Page } from "../../components/app-shell.js";
import { PairingCode } from "@cpay/glasses-kit/hub";
import { cleanPairCode, getHub, glassesState, type GlassesState } from "../../lib/hub-client.js";
import { useHubStatus, useWallet } from "../../lib/hooks.js";
import { isActive } from "../../lib/pay-machine.js";
import { syncEvery } from "../../lib/railgun.js";
import { installRejectionGuard } from "../../lib/pay-errors.js";
import { payStatus } from "../../lib/pay-status.js";
import { errText, toast } from "../../lib/toast.js";
import { currentWallet, hasWallet } from "../../lib/wallet.js";
import { UnlockButton } from "../../components/unlock-button.js";
import { PayController } from "./controller.js";
import { PayDetails } from "./pay-details.js";
import { PayActions, PayStage } from "./pay-stage.js";

export function PayScreen() {
  const hub = useHubStatus();
  const wallet = useWallet();
  const ctrl = useMemo(() => new PayController(getHub(), currentWallet), []);
  // attach: hub status (glasses drop -> stop camera/mic; glasses up -> maybe ask "want to pay?"); detach on leave.
  useEffect(() => ctrl.attach(), [ctrl]);
  // Any stray rejection on this tab ends visibly (a generic toast only when no payment is being sent).
  useEffect(
    () => installRejectionGuard(() => ctrl.getView().state.s === "PAYING", (t) => toast.error(t)),
    [ctrl],
  );
  // Keep the Railgun private balance fresh while this tab is open.
  useEffect(() => syncEvery(currentWallet), []);
  const view = useSyncExternalStore(ctrl.subscribe, ctrl.getView, ctrl.getView);
  const active = isActive(view.state);

  const [exists, setExists] = useState<boolean | null>(null);
  useEffect(() => {
    hasWallet().then(setExists, () => setExists(false));
  }, []);

  // Wallet locked / unlocked: a lock stops a running session (not a payment being sent); an unlock may ask.
  const unlocked = !!wallet;
  useEffect(() => ctrl.walletChanged(unlocked), [unlocked, ctrl]);

  if (!wallet) {
    return (
      <Shell>
        <Locked title={exists === false ? "No wallet yet" : "Wallet locked"} sub="Unlock with your passkey to pay.">
          {exists === false ? (
            <Link href="/onboarding" className="block min-h-14 rounded-2xl bg-emerald-500 px-5 py-4 text-center text-lg font-semibold text-black">
              Create wallet
            </Link>
          ) : (
            <UnlockButton disabled={exists === null} />
          )}
        </Locked>
      </Shell>
    );
  }

  // Pay unlocks only while YOUR glasses are paired and online (glassesState: one source of truth for every screen).
  // A session that is running or just paid stays on screen through a glasses drop, so its outcome is never hidden.
  const glasses = glassesState(hub);
  const st = view.state;
  const keepStage = active || st.s === "PAID" || (st.s === "FAILED" && !!st.maybeSent);
  if (glasses !== "paired" && !keepStage) {
    const needsCode = glasses === "unpaired" || glasses === "restarted";
    const last = st.s === "IDLE" ? null : payStatus(st, { privateSend: view.privateSend, micOn: false });
    return (
      <Shell>
        <Locked glasses title={GLASSES_TITLE[glasses]} sub={GLASSES_SUB[glasses]} note={last}>
          {needsCode && <PairCodeForm />}
          <div className="flex justify-center gap-2">
            <Link href="/settings" className={SMALL_LINK}>
              Settings
            </Link>
            <Link href="/receive" className={SMALL_LINK}>
              Receive instead
            </Link>
          </div>
        </Locked>
        {view.log.length > 0 && <PayDetails view={view} />}
      </Shell>
    );
  }

  return (
    <Shell>
      <PayStage view={view} ctrl={ctrl} canScan={glasses === "paired"} />
      <PayActions view={view} ctrl={ctrl} canScan={glasses === "paired"} />
      <PayDetails view={view} />
    </Shell>
  );
}

/** Inline pairing: type the code shown on the glasses right here, no trip to Settings. */
function PairCodeForm() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = PairingCode.safeParse(code).success;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        getHub()
          .pair(code)
          .then(
            () => {
              toast.success("Paired. The glasses are linked to this phone only.");
              setCode("");
            },
            (err) => toast.error(errText(err)),
          )
          .finally(() => setBusy(false));
      }}
    >
      <input
        aria-label="6-character code on the glasses"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={6}
        value={code}
        onChange={(e) => setCode(cleanPairCode(e.target.value))}
        className="w-full rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-4 text-center font-mono text-3xl tracking-[0.3em]"
        placeholder="ABC234"
      />
      <button
        type="submit"
        disabled={!valid || busy}
        className="min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
      >
        {busy ? "Pairing…" : "Pair glasses"}
      </button>
    </form>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    // The glasses pill lives in the app header now (components/app-shell.tsx).
    <Page>{children}</Page>
  );
}

const SMALL_LINK =
  "inline-flex min-h-11 items-center rounded-2xl border border-neutral-800 px-4 text-sm font-medium text-neutral-300 hover:border-emerald-500/40 hover:text-neutral-100";

/** Short titles for the locked Pay tab (the header pill already says the glasses state in detail). */
const GLASSES_TITLE: Record<GlassesState, string> = {
  no_hub: "Glasses not set up",
  unpaired: "Pair your glasses",
  restarted: "Glasses restarted",
  connecting: "Connecting to your glasses…",
  offline: "Glasses offline",
  paired: "Paired",
};

const GLASSES_SUB: Record<GlassesState, string> = {
  no_hub: "This build has no glasses hub.",
  unpaired: "Enter the code shown on your glasses.",
  restarted: "Enter the new code shown on your glasses.",
  connecting: "Pay unlocks when they're online.",
  offline: "Pay unlocks when they're online.",
  paired: "",
};

function Locked({ title, sub, note, glasses, children }: { title: string; sub?: string; note?: string | null; glasses?: boolean; children: ReactNode }) {
  return (
    <section className="flex min-h-[50vh] flex-col justify-center gap-6 text-center">
      <div className="space-y-2">
        {glasses && (
          <span aria-hidden className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/30">
            <svg viewBox="0 0 32 32" className="h-8 w-8 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="9" cy="18" r="5" />
              <circle cx="23" cy="18" r="5" />
              <path d="M14 17.5c1.2-1 2.8-1 4 0M4 18l-1-6M28 18l1-6" />
            </svg>
          </span>
        )}
        <p className="text-2xl font-semibold tracking-tight">{title}</p>
        {sub && <p className="text-neutral-400">{sub}</p>}
        {note && (
          <p role="status" className="mx-auto max-w-xs pt-2 text-sm text-neutral-500">
            {note}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}
