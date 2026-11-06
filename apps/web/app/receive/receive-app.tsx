"use client";
// Receive tab. The private CPay QR is the hero and the default (invariant 8); the public address QR only behind a
// warning. The background recipient (lib/recipient-service.ts) answers face probes and quotes while the app is open.
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Card } from "@cpay/credential";
import { AddressQr } from "../../components/address-qr.js";
import { useStoredTemplate } from "../../components/face-enrol.js";
import { NotConnected } from "../../components/ui.js";
import { errorMessage } from "../../lib/deps.js";
import { useWallet } from "../../lib/hooks.js";
import { publicConfig } from "../../lib/public-config.js";
import { getRecipient, type RecipientStatus } from "../../lib/recipient-service.js";
import { toast } from "../../lib/toast.js";
import { VAULT, vaultGet } from "../../lib/vault.js";
import { unlockWallet } from "../../lib/wallet.js";
import { CredentialStep } from "./credential-step.js";
import { InvisibleToggle, PublicQr, ReceiveDetails } from "./receive-parts.js";

export function useRecipient(): RecipientStatus {
  const [s, set] = useState<RecipientStatus>(() => getRecipient().status);
  useEffect(() => getRecipient().onStatus(set), []);
  return s;
}

export function ReceiveApp() {
  const wallet = useWallet();
  const rs = useRecipient();
  const [template, setTemplate] = useStoredTemplate();
  const [cardV, setCard] = useState<Card | null | undefined>(undefined);
  const [showPublic, setShowPublic] = useState(false);

  useEffect(() => {
    vaultGet<Card>(VAULT.card).then(setCard, (e) => {
      setCard(null);
      toast.error(`On-device vault unavailable: ${errorMessage(e)}`);
    });
    void getRecipient().start();
  }, []);

  const qr = rs.cpayQr;
  const qrVisible = !!cardV && !!wallet && !rs.invisible && !!rs.peerId && !!publicConfig.relayUrl && !showPublic;

  // QR quotes are answered only while the private QR is actually on screen, and only with its current secret
  // (fresh on every show and after every payment).
  useEffect(() => {
    const r = getRecipient();
    const sync = () => r.setShowingCpayQr(qrVisible && document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      r.setShowingCpayQr(false);
    };
  }, [qrVisible]);

  if (cardV === undefined || template === undefined) {
    return (
      <p role="status" className="py-24 text-center text-neutral-500">
        Opening your on-device vault…
      </p>
    );
  }

  const onCard = (c: Card) => {
    setCard(c);
    void getRecipient().start();
  };

  return (
    <>
      <section aria-label="Private CPay QR" className="flex min-h-[50vh] flex-col items-center justify-center gap-5 text-center">
        {!cardV ? (
          <p className="max-w-xs text-neutral-400">Verify once with World ID to get your private QR. Payers will only learn &ldquo;verified human&rdquo;.</p>
        ) : !wallet ? (
          <>
            <p className="max-w-xs text-neutral-400">Unlock your wallet: one-time addresses are derived from it on this phone.</p>
            <button
              className="min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black"
              onClick={() => unlockWallet().catch((e) => toast.error(errorMessage(e)))}
            >
              Unlock with passkey
            </button>
          </>
        ) : rs.invisible ? (
          <p className="max-w-xs text-neutral-400">You&apos;re invisible: no QR, no face matches.</p>
        ) : !publicConfig.relayUrl ? (
          <NotConnected id="relay" detail="NEXT_PUBLIC_RELAY_URL is not set" />
        ) : showPublic ? (
          <p className="max-w-xs text-neutral-400">Private QR hidden while the public one is shown.</p>
        ) : qr ? (
          <>
            <AddressQr value={qr} size={260} alt="Your private CPay QR" />
            <div>
              <p className="text-sm font-medium text-emerald-300">Private · one payment</p>
              <p className="mt-1 max-w-xs text-xs text-neutral-500">
                Payers see only &ldquo;World-verified human&rdquo; and a fresh one-time address. No address in the QR; it changes after each
                payment.
              </p>
            </div>
          </>
        ) : (
          <span role="status" aria-label="Connecting to the relay" className="grid h-28 w-28 place-items-center">
            <span className="cpay-orb block h-14 w-14 rounded-full bg-emerald-400/70" />
          </span>
        )}
      </section>

      {!cardV && <CredentialStep card={cardV} onCard={onCard} enabled />}

      <div className="space-y-3">
        <Link
          href="/receive/ready"
          className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black hover:bg-emerald-400"
        >
          Ready to get paid
        </Link>
        <InvisibleToggle rs={rs} faceOn={!!template} />
      </div>

      <PublicQr address={wallet?.address ?? null} shown={showPublic} onShow={setShowPublic} />

      <ReceiveDetails rs={rs} card={cardV} onCard={onCard} template={template} onTemplate={(t) => void setTemplate(t)} />
    </>
  );
}
