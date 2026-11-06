"use client";
// Pay tab: glasses pill, one large stage, one action row, then collapsed Details. All transient feedback is a
// toast that appears in sync with the spoken reply (controller.say).
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { GlassesPill, Page } from "../../components/app-shell.js";
import { PairingCode } from "@cpay/glasses-kit/hub";
import { cleanPairCode, getHub, glassesState, GLASSES_TEXT } from "../../lib/hub-client.js";
import { useHubStatus, useWallet } from "../../lib/hooks.js";
import { isActive } from "../../lib/pay-machine.js";
import { syncEvery } from "../../lib/railgun.js";
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
  useEffect(() => () => ctrl.dispose(), [ctrl]);
  // Keep the Railgun private balance fresh while this tab is open.
  useEffect(() => syncEvery(currentWallet), []);
  const view = useSyncExternalStore(ctrl.subscribe, ctrl.getView, ctrl.getView);
  const active = isActive(view.state);

  const [exists, setExists] = useState<boolean | null>(null);
  useEffect(() => {
    hasWallet().then(setExists, () => setExists(false));
  }, []);

  // Glasses dropped mid-session: stop the camera/mic path (a payment being sent still finishes).
  useEffect(() => {
    if (!hub.online && active) ctrl.stop();
  }, [hub.online, active, ctrl]);

  if (!wallet) {
    return (
      <Shell>
        <Locked title="Wallet locked">
          {exists === false ? (
            <Link href="/onboarding" className="block min-h-14 rounded-2xl bg-emerald-500 px-5 py-4 text-center text-lg font-semibold text-black">
              Create your wallet
            </Link>
          ) : (
            <UnlockButton />
          )}
        </Locked>
      </Shell>
    );
  }

  // Pay unlocks only while YOUR glasses are paired and online (glassesState: one source of truth for every screen).
  const glasses = glassesState(hub);
  if (glasses !== "paired") {
    const needsCode = glasses === "unpaired" || glasses === "restarted";
    return (
      <Shell>
        <Locked
          title={GLASSES_TEXT[glasses]}
          sub={
            glasses === "offline"
              ? "Pay needs your glasses online. Receiving works without them."
              : glasses === "no_hub"
                ? "This build has no glasses hub. Receiving works without glasses."
                : "Pairing lasts until the glasses power off. Receiving works without them."
          }
        >
          {needsCode && <PairCodeForm />}
          <Link href="/receive" className="flex min-h-14 items-center justify-center rounded-2xl border border-neutral-800 font-semibold">
            Receive instead
          </Link>
        </Locked>
        {view.log.length > 0 && <PayDetails view={view} />}
      </Shell>
    );
  }

  return (
    <Shell>
      <PayStage view={view} ctrl={ctrl} />
      <PayActions view={view} ctrl={ctrl} />
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
        className="w-full rounded-xl border border-neutral-800 bg-transparent px-4 py-4 text-center font-mono text-3xl tracking-[0.3em]"
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
    <Page>
      <div className="flex justify-center">
        <GlassesPill />
      </div>
      {children}
    </Page>
  );
}

function Locked({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex min-h-[45vh] flex-col justify-center gap-6 text-center">
      <div>
        <p className="text-2xl font-semibold">{title}</p>
        {sub && <p className="mt-2 text-neutral-400">{sub}</p>}
      </div>
      {children}
    </section>
  );
}
