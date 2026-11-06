"use client";
// Receive tab. Private CPay QR first (invariant 8); the public address QR only behind a warning.
// The background recipient (lib/recipient-service.ts) answers face probes and quotes while the app is open.
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Card } from "@cpay/credential";
import { AddressQr } from "../../components/address-qr.js";
import { FaceEnrol, useStoredTemplate } from "../../components/face-enrol.js";
import { Button, ErrorNote, NotConnected } from "../../components/ui.js";
import { errorMessage } from "../../lib/deps.js";
import { useWallet } from "../../lib/hooks.js";
import { publicConfig } from "../../lib/public-config.js";
import { getRecipient, type RecipientStatus } from "../../lib/recipient-service.js";
import { VAULT, vaultGet, vaultWipe } from "../../lib/vault.js";
import { unlockWallet } from "../../lib/wallet.js";
import { CredentialStep } from "./credential-step.js";

function useRecipient(): RecipientStatus {
  const [s, set] = useState<RecipientStatus>(() => getRecipient().status);
  useEffect(() => getRecipient().onStatus(set), []);
  return s;
}

const card = "rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5";

export function ReceiveApp() {
  const wallet = useWallet();
  const rs = useRecipient();
  const [template, setTemplate] = useStoredTemplate();
  const [cardV, setCard] = useState<Card | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [showPublic, setShowPublic] = useState(false);

  useEffect(() => {
    vaultGet<Card>(VAULT.card).then(setCard, (e) => {
      setCard(null);
      setErr(`on-device vault unavailable: ${errorMessage(e)}`);
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

  async function wipe() {
    if (!confirm("Delete your face template, World ID card and one-time address list from this phone?")) return;
    await vaultWipe();
    location.reload();
  }

  if (cardV === undefined || template === undefined) return <p className="text-neutral-400">Opening your on-device vault…</p>;

  return (
    <div className="space-y-4">
      {err && <ErrorNote>{err}</ErrorNote>}

      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Private CPay QR</h2>
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">default</span>
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          Payers see only &ldquo;World-verified human&rdquo; and a fresh one-time address. Each payment lands somewhere new.
        </p>
        <div className="mt-4">
          {!cardV ? (
            <p className="text-sm text-amber-200">Verify with World ID below to get your private QR.</p>
          ) : !wallet ? (
            <div className="space-y-2">
              <p className="text-sm text-amber-200">Unlock your wallet: one-time addresses are derived from it on this phone.</p>
              <Button className="w-full" onClick={() => unlockWallet().catch((e) => setErr(errorMessage(e)))}>
                Unlock with passkey
              </Button>
            </div>
          ) : rs.invisible ? (
            <p className="text-sm text-neutral-400">You&apos;re invisible: no QR, no face matches. Turn it off below.</p>
          ) : !publicConfig.relayUrl ? (
            <NotConnected id="relay" detail="NEXT_PUBLIC_RELAY_URL is not set" />
          ) : qr ? (
            <div className="flex flex-col items-center gap-2">
              <AddressQr value={qr} size={240} alt="Your private CPay QR" />
              <p className="text-center text-xs text-neutral-500">
                Good for one payment: it changes after each one, every time you open it and on every reconnect. Contains no address, only a
                relay key and a one-time secret.
              </p>
            </div>
          ) : (
            <p className="text-sm text-neutral-400">Connecting to the relay… {rs.detail}</p>
          )}
        </div>
      </section>

      <Link
        href="/receive/ready"
        className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black hover:bg-emerald-400"
      >
        Ready to get paid
      </Link>

      <button
        onClick={() => void getRecipient().setInvisible(!rs.invisible)}
        aria-pressed={rs.invisible}
        className={`flex min-h-16 w-full items-center justify-between rounded-2xl border px-5 text-left ${rs.invisible ? "border-neutral-700 bg-neutral-800" : "border-emerald-500/50 bg-emerald-500/10"}`}
      >
        <span>
          <span className="block text-lg font-semibold">{rs.invisible ? "Invisible" : "Payable"}</span>
          <span className="block text-xs text-neutral-400">
            {rs.invisible ? "Not connected to the relay. Tap to become payable." : `Relay: ${rs.relay}${template ? " · face pay on" : " · face pay off (not enrolled)"}. Tap to go invisible.`}
          </span>
        </span>
        <span className={`h-8 w-14 rounded-full p-1 ${rs.invisible ? "bg-neutral-600" : "bg-emerald-500"}`}>
          <span className={`block h-6 w-6 rounded-full bg-white transition ${rs.invisible ? "" : "translate-x-6"}`} />
        </span>
      </button>

      <CredentialStep
        card={cardV}
        onCard={(c) => {
          setCard(c);
          void getRecipient().start();
        }}
        enabled
      />

      <FaceEnrol template={template} onTemplate={(t) => void setTemplate(t)} title="Face pay (optional)" />

      <section className={card}>
        <h2 className="text-lg font-semibold">Public address QR</h2>
        {!showPublic ? (
          <>
            <p className="mt-1 text-sm text-amber-200/90">
              Shows your agent wallet address. Anyone who sees it can look up its whole history and balance, and every payment to it is
              linked. Prefer the private QR.
            </p>
            <Button tone="secondary" className="mt-3 w-full" disabled={!wallet} onClick={() => setShowPublic(true)}>
              {wallet ? "I understand, show public QR" : "Unlock wallet first"}
            </Button>
          </>
        ) : (
          wallet && (
            <div className="mt-3 flex flex-col items-center gap-2">
              <AddressQr value={wallet.address} alt="Your public address QR" />
              <p className="break-all font-mono text-xs text-neutral-400">{wallet.address}</p>
              <Button tone="secondary" className="w-full" onClick={() => setShowPublic(false)}>
                Back to private QR
              </Button>
            </div>
          )
        )}
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">Recipient log (this phone only)</h2>
        <ul className="max-h-56 space-y-1 overflow-auto text-xs text-neutral-400">
          {rs.log.length === 0 && <li className="text-neutral-500">Nothing yet.</li>}
          {rs.log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              {new Date(l.at).toLocaleTimeString()} · {l.text}
            </li>
          ))}
        </ul>
      </section>

      <Button tone="danger" onClick={wipe} className="w-full">
        Delete face template + card from this phone
      </Button>
    </div>
  );
}
