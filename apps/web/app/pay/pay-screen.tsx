"use client";
// Pay tab: glasses pill, one large stage, one action row, then collapsed Details. All transient feedback is a
// toast that appears in sync with the spoken reply (controller.say).
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { GlassesPill, Page } from "../../components/app-shell.js";
import { getHub } from "../../lib/hub-client.js";
import { useHubStatus, useWallet } from "../../lib/hooks.js";
import { isActive } from "../../lib/pay-machine.js";
import { syncEvery } from "../../lib/railgun.js";
import { errText, toast } from "../../lib/toast.js";
import { currentWallet, hasWallet, unlockWallet } from "../../lib/wallet.js";
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
            <button
              className="min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black"
              onClick={() => unlockWallet().catch((e) => toast.error(errText(e)))}
            >
              Unlock with passkey
            </button>
          )}
        </Locked>
      </Shell>
    );
  }

  if (hub.conn !== "connected" || !hub.online) {
    const needsPair = hub.conn === "unpaired" || hub.conn === "no_hub";
    return (
      <Shell>
        <Locked title="Glasses disconnected · receive only" sub={needsPair ? "Pair your glasses to pay hands-free." : "Waiting for your glasses…"}>
          <div className="grid grid-cols-2 gap-3">
            <Link href="/settings" className="flex min-h-14 items-center justify-center rounded-2xl border border-neutral-800 font-semibold">
              {needsPair ? "Pair glasses" : "Settings"}
            </Link>
            <Link href="/receive" className="flex min-h-14 items-center justify-center rounded-2xl border border-neutral-800 font-semibold">
              Receive
            </Link>
          </div>
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
