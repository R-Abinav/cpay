"use client";
// Receive tab pieces: verified badge, invisible toggle, face pay row (deep link to Settings), public QR behind its
// warning, and the collapsed "More" (World ID card, recipient log, wipe).
import Link from "next/link";
import { useState } from "react";
import type { Card } from "@cpay/credential";
import { AddressQr } from "../../components/address-qr.js";
import { Address, Button, Details } from "../../components/ui.js";
import { getRecipient, type RecipientStatus } from "../../lib/recipient-service.js";
import { errText, toast } from "../../lib/toast.js";
import { vaultWipe } from "../../lib/vault.js";
import { CredentialStep } from "./credential-step.js";

export function VerifiedBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      World-verified human
    </span>
  );
}

export function InvisibleToggle({ rs, faceOn }: { rs: RecipientStatus; faceOn: boolean }) {
  const visible = !rs.invisible;
  const online = rs.relay === "open";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={visible}
      onClick={() => void getRecipient().setInvisible(visible)}
      className="flex min-h-16 w-full items-center justify-between gap-4 rounded-2xl border border-neutral-800 px-4 py-3 text-left hover:bg-neutral-900/50"
    >
      <span className="flex items-center gap-3">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${!visible ? "bg-neutral-600" : online ? "bg-emerald-400" : "bg-amber-400"}`}
          aria-hidden
        />
        <span>
          <span className="block font-semibold">{visible ? "Payable" : "Invisible"}</span>
          <span className="block text-xs text-neutral-500">
            {visible ? `${online ? "Online" : "Connecting…"}${faceOn ? " · face pay on" : ""}` : "Nobody can find or pay you"}
          </span>
        </span>
      </span>
      <span className={`h-7 w-12 shrink-0 rounded-full p-0.5 transition-colors ${visible ? "bg-emerald-500" : "bg-neutral-700"}`} aria-hidden>
        <span className={`block h-6 w-6 rounded-full bg-white transition-transform motion-reduce:transition-none ${visible ? "translate-x-5" : ""}`} />
      </span>
    </button>
  );
}

/** Face pay status. Enrol / re-enrol happen in Settings so the camera UI stays off this screen. */
export function FaceRow({ enrolled }: { enrolled: boolean }) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-4 rounded-2xl border border-neutral-800 px-4 py-3">
      <span>
        <span className="block font-semibold">Face pay</span>
        <span className="block text-xs text-neutral-500">{enrolled ? "Enrolled · stays on this phone" : "Optional · get paid by a glance"}</span>
      </span>
      <Link
        href="/settings#face"
        className="inline-flex min-h-11 shrink-0 items-center rounded-xl border border-neutral-800 px-4 text-sm font-semibold text-neutral-200 hover:bg-neutral-900"
      >
        {enrolled ? "Re-enrol" : "Set up"}
      </Link>
    </div>
  );
}

/** Secondary: show the public address QR, only after a one-line warning. */
export function PublicQrToggle({ disabled, onShow }: { disabled: boolean; onShow: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAsking(true)}
        className="min-h-12 w-full rounded-2xl px-4 text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
      >
        {disabled ? "Unlock to show your public address" : "Show public address QR"}
      </button>
    );
  }
  return (
    <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-sm text-amber-200/90">Anyone who sees your public address can see its whole history and balance.</p>
      <div className="flex gap-2">
        <Button tone="secondary" className="flex-1" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button
          tone="secondary"
          className="flex-1 border-amber-500/40 text-amber-200"
          onClick={() => {
            setAsking(false);
            onShow();
          }}
        >
          Show anyway
        </Button>
      </div>
    </div>
  );
}

/** Shown in the hero card in place of the private QR. */
export function PublicQrCard({ address, onBack }: { address: string; onBack: () => void }) {
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="rounded-3xl bg-white p-3">
        <AddressQr value={address} size={240} alt="Your public address QR" />
      </div>
      <Address value={address} label="public address" className="text-sm text-neutral-300" />
      <p className="text-xs text-amber-300/90">Linkable: every payment to it is public.</p>
      <Button className="w-full" onClick={onBack}>
        Back to private QR
      </Button>
    </div>
  );
}

export function ReceiveDetails({ rs, card, onCard }: { rs: RecipientStatus; card: Card | null; onCard: (c: Card) => void }) {
  async function wipe() {
    if (!confirm("Delete your face template, World ID card and one-time address list from this phone?")) return;
    try {
      await vaultWipe();
      location.reload();
    } catch (e) {
      toast.error(`Wipe failed: ${errText(e)}`);
    }
  }
  return (
    <Details summary="More">
      <div className="space-y-2 text-sm text-neutral-400">
        <p className="font-medium text-neutral-200">How it works</p>
        <p>Payers scan your QR and get a fresh one-time address plus proof you&apos;re a World-verified human. Never your wallet or name.</p>
      </div>
      {card && <CredentialStep card={card} onCard={onCard} enabled />}
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">Activity on this phone</h3>
        <ul className="space-y-1 text-xs text-neutral-400">
          {rs.log.length === 0 && <li className="text-neutral-600">Nothing yet.</li>}
          {rs.log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              <span className="font-mono text-neutral-600">{new Date(l.at).toLocaleTimeString()}</span> {l.text}
            </li>
          ))}
        </ul>
      </div>
      <Button tone="danger" onClick={wipe} className="w-full">
        Delete face + card from this phone
      </Button>
    </Details>
  );
}
