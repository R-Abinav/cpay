"use client";
// Receive tab pieces under the hero: invisible toggle, public QR behind its warning, and collapsed Details
// (World ID card, face pay, recipient log, wipe).
import type { Card } from "@cpay/credential";
import { AddressQr } from "../../components/address-qr.js";
import { FaceEnrol, type StoredTemplate } from "../../components/face-enrol.js";
import { Button, Details } from "../../components/ui.js";
import { getRecipient, type RecipientStatus } from "../../lib/recipient-service.js";
import { errText, toast } from "../../lib/toast.js";
import { vaultWipe } from "../../lib/vault.js";
import { CredentialStep } from "./credential-step.js";

export function InvisibleToggle({ rs, faceOn }: { rs: RecipientStatus; faceOn: boolean }) {
  const visible = !rs.invisible;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={visible}
      onClick={() => void getRecipient().setInvisible(visible)}
      className="flex min-h-16 w-full items-center justify-between gap-4 rounded-2xl border border-neutral-900 px-4 text-left"
    >
      <span>
        <span className="block font-semibold">{visible ? "Payable" : "Invisible"}</span>
        <span className="block text-xs text-neutral-500">
          {visible ? `Relay ${rs.relay}${faceOn ? " · face pay on" : ""}. Turn off to go invisible.` : "Not on the relay. Nobody can pay you."}
        </span>
      </span>
      <span className={`h-7 w-12 shrink-0 rounded-full p-0.5 transition-colors ${visible ? "bg-emerald-500" : "bg-neutral-700"}`} aria-hidden>
        <span className={`block h-6 w-6 rounded-full bg-white transition-transform motion-reduce:transition-none ${visible ? "translate-x-5" : ""}`} />
      </span>
    </button>
  );
}

export function PublicQr({ address, shown, onShow }: { address: string | null; shown: boolean; onShow: (v: boolean) => void }) {
  return (
    <section className="border-t border-neutral-900 pt-6">
      <h2 className="text-base font-semibold">Public address QR</h2>
      {!shown || !address ? (
        <>
          <p className="mt-1 text-sm text-amber-300/90">
            Shows your agent wallet address. Anyone who sees it can look up its whole history and balance, and every payment to it is linked.
            Prefer the private QR.
          </p>
          <Button tone="secondary" className="mt-4 w-full" disabled={!address} onClick={() => onShow(true)}>
            {address ? "I understand, show public QR" : "Unlock wallet first"}
          </Button>
        </>
      ) : (
        <div className="mt-4 flex flex-col items-center gap-3">
          <AddressQr value={address} alt="Your public address QR" />
          <p className="break-all text-center font-mono text-xs text-neutral-400">{address}</p>
          <Button className="w-full" onClick={() => onShow(false)}>
            Back to private QR
          </Button>
        </div>
      )}
    </section>
  );
}

export function ReceiveDetails({
  rs,
  card,
  onCard,
  template,
  onTemplate,
}: {
  rs: RecipientStatus;
  card: Card | null;
  onCard: (c: Card) => void;
  template: StoredTemplate | null;
  onTemplate: (t: StoredTemplate | null) => void;
}) {
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
    <Details>
      {card && <CredentialStep card={card} onCard={onCard} enabled />}
      <FaceEnrol template={template} onTemplate={onTemplate} title="Face pay (optional)" />
      <div className="border-t border-neutral-900 pt-6">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">Recipient log (this phone only)</h3>
        <ul className="space-y-1 text-xs text-neutral-400">
          {rs.log.length === 0 && <li className="text-neutral-600">Nothing yet.</li>}
          {rs.log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              {new Date(l.at).toLocaleTimeString()} · {l.text}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-neutral-500">Private by default. Your keys, card and face template stay on this phone.</p>
      <Button tone="danger" onClick={wipe} className="w-full">
        Delete face template + card from this phone
      </Button>
    </Details>
  );
}
