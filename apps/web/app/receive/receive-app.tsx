"use client";
// Receive tab. The private CPay QR is the hero and the default (invariant 8); the public address QR only behind a
// warning, and it replaces the private one in the card while shown. Face enrolment lives in Settings (#face). The background recipient (lib/recipient-service.ts) answers face probes and quotes while the app is open.
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
import { hasWallet } from "../../lib/wallet.js";
import { UnlockButton } from "../../components/unlock-button.js";
import { CredentialStep } from "./credential-step.js";
import { FaceRow, InvisibleToggle, PublicQrCard, PublicQrToggle, ReceiveDetails, VerifiedBadge } from "./receive-parts.js";

export function useRecipient(): RecipientStatus {
  const [s, set] = useState<RecipientStatus>(() => getRecipient().status);
  useEffect(() => getRecipient().onStatus(set), []);
  return s;
}

export function ReceiveApp() {
  const wallet = useWallet();
  const rs = useRecipient();
  const [template] = useStoredTemplate();
  const [cardV, setCard] = useState<Card | null | undefined>(undefined);
  const [showPublic, setShowPublic] = useState(false);
  const [exists, setExists] = useState<boolean | null>(null);
  useEffect(() => {
    hasWallet().then(setExists, () => setExists(false));
  }, []);

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

  const loading = cardV === undefined || template === undefined;

  const onCard = (c: Card) => {
    setCard(c);
    void getRecipient().start();
  };

  const publicOn = showPublic && !!wallet;

  return (
    <>
      <section
        aria-label={publicOn ? "Public address QR" : "Private CPay QR"}
        className={`rounded-3xl border bg-neutral-950/70 p-5 ${publicOn ? "border-amber-500/30" : "border-neutral-800"}`}
      >
        <div className="flex min-h-7 items-center justify-between gap-3">
          <p className={`text-xs font-semibold uppercase tracking-widest ${publicOn ? "text-amber-300" : "text-emerald-400"}`}>
            {publicOn ? "Public address" : "Private QR"}
          </p>
          {!publicOn && cardV && <VerifiedBadge />}
        </div>

        <div className="flex min-h-[340px] flex-col items-center justify-center gap-4 text-center">
          {loading ? (
            <Orb label="Opening your vault" />
          ) : publicOn && wallet ? (
            <PublicQrCard address={wallet.address} onBack={() => setShowPublic(false)} />
          ) : !cardV ? (
            <div className="w-full space-y-4">
              <div>
                <p className="text-xl font-semibold">Get your private QR</p>
                <p className="mx-auto mt-1 max-w-xs text-sm text-neutral-400">Verify once with World ID. Payers only learn you&apos;re a real human.</p>
              </div>
              <CredentialStep card={cardV} onCard={onCard} enabled bare />
            </div>
          ) : !wallet && exists === false ? (
            <div className="w-full space-y-4">
              <p className="text-neutral-400">No wallet on this phone yet.</p>
              <Link href="/onboarding" className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black">
                Create wallet
              </Link>
            </div>
          ) : !wallet ? (
            <div className="w-full space-y-4">
              <p className="text-neutral-400">Unlock to show your private QR.</p>
              <UnlockButton disabled={exists === null} />
            </div>
          ) : rs.invisible ? (
            <div>
              <p className="text-xl font-semibold">You&apos;re invisible</p>
              <p className="mt-1 text-sm text-neutral-400">No QR, no face matches. Turn on Payable to show it.</p>
            </div>
          ) : !publicConfig.relayUrl ? (
            <NotConnected id="relay" detail="NEXT_PUBLIC_RELAY_URL is not set" />
          ) : qr ? (
            <>
              <div className="rounded-3xl bg-white p-3 shadow-[0_0_60px_-15px_rgba(16,185,129,0.45)]">
                <AddressQr value={qr} size={260} alt="Your private CPay QR" />
              </div>
              <p className="text-sm text-neutral-400">A fresh one-time address for every payment.</p>
            </>
          ) : (
            <Orb label="Connecting…" />
          )}
        </div>
      </section>

      <div className="space-y-3">
        <Link
          href="/receive/ready"
          className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black hover:bg-emerald-400"
        >
          Ready to get paid
        </Link>
        <InvisibleToggle rs={rs} faceOn={!!template} />
        {!loading && <FaceRow enrolled={!!template} />}
        {!publicOn && <PublicQrToggle disabled={!wallet} onShow={() => setShowPublic(true)} />}
      </div>

      {!loading && <ReceiveDetails rs={rs} card={cardV} onCard={onCard} />}
    </>
  );
}

function Orb({ label }: { label: string }) {
  return (
    <span role="status" aria-label={label} className="grid h-28 w-28 place-items-center">
      <span className="cpay-orb block h-14 w-14 rounded-full bg-emerald-400/70" />
    </span>
  );
}
