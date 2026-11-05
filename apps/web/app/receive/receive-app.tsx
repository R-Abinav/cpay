"use client";
import { useEffect, useState } from "react";
import type { Card } from "@cpay/credential";
import type { StealthKeys } from "@cpay/stealth";
import { Button, ErrorNote } from "../../components/ui.js";
import { errorMessage } from "../../lib/deps.js";
import { FACE_MODEL_ID } from "../../lib/face/engine.js";
import { VAULT, vaultDelete, vaultGet, vaultWipe } from "../../lib/vault.js";
import { CredentialStep } from "./credential-step.js";
import { FaceStep, type StoredTemplate } from "./face-step.js";
import { ListenStep } from "./listen-step.js";
import { WalletStep } from "./wallet-step.js";

export function ReceiveApp() {
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [keys, setKeys] = useState<StealthKeys | null>(null);
  const [template, setTemplate] = useState<StoredTemplate | null>(null);
  const [card, setCard] = useState<Card | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [k, t, c] = await Promise.all([
          vaultGet<StealthKeys>(VAULT.stealthKeys),
          vaultGet<StoredTemplate>(VAULT.template),
          vaultGet<Card>(VAULT.card),
        ]);
        setKeys(k);
        // A template from a different model can't be compared; force re-enrolment.
        setTemplate(t && t.model === FACE_MODEL_ID ? t : null);
        setCard(c);
      } catch (e) {
        setErr(`on-device vault unavailable: ${errorMessage(e)}`);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function changeTemplate(t: StoredTemplate | null) {
    if (!t) await vaultDelete(VAULT.template);
    setTemplate(t);
  }

  async function wipe() {
    if (!confirm("Delete your face template, card and receiving keys from this phone?")) return;
    await vaultWipe();
    location.reload();
  }

  if (!loaded) return <p className="text-neutral-400">Opening your on-device vault…</p>;
  return (
    <div className="space-y-4">
      {err && <ErrorNote>{err}</ErrorNote>}
      <WalletStep keys={keys} onKeys={setKeys} />
      <FaceStep template={template} onTemplate={changeTemplate} />
      <CredentialStep card={card} onCard={setCard} enabled={!!keys && !!template} />
      {keys && template ? (
        <ListenStep keys={keys} template={template.template} card={card} />
      ) : (
        <p className="px-1 text-sm text-neutral-500">Step 4 (receive payments) unlocks after keys and face enrolment.</p>
      )}
      <Button tone="danger" onClick={wipe} className="w-full">Delete everything from this phone</Button>
    </div>
  );
}
