"use client";
// World ID step: passkey-derived BBS commitment -> World IDKit (Proof of Human, signal = hash(C), RP signature from the issuer)
// -> issuer /enrol (verifies with World, stores the nullifier, blind-signs) -> unblind -> verify -> store the card.
// Uses the headless IDKit hook (the stock widget pulls fonts from a CDN, which CROPS forbids).
// BBS (WASM, MBs) and IDKit load only after "Verify with World ID" is tapped, so Receive/Onboarding paint fast.
import dynamic from "next/dynamic";
import { useState } from "react";
import type { Card, HolderCommitment } from "@cpay/credential";
import { WORLD_ACTION, buildIdkitRequest, type IdkitRequestConfig } from "@cpay/world";
import { Button, NotConnected, Section } from "../../components/ui.js";
import { errorMessage, isNotImplemented, type DependencyId } from "../../lib/deps.js";
import { enrolWithIssuer, fetchIssuerPublicKey } from "../../lib/issuer-client.js";
import { publicConfig } from "../../lib/public-config.js";
import { VAULT, vaultDelete, vaultSet } from "../../lib/vault.js";
import { toast } from "../../lib/toast.js";
import { bbsSeed } from "../../lib/wallet.js";

const credential = () => import("@cpay/credential");
const WorldFlow = dynamic(() => import("./world-flow.js").then((m) => m.WorldFlow), {
  ssr: false,
  loading: () => <p role="status" className="text-sm text-neutral-400">Connecting to World…</p>,
});

type Phase =
  | { k: "idle" }
  | { k: "preparing" }
  | { k: "world"; cfg: IdkitRequestConfig; hc: HolderCommitment }
  | { k: "issuing" }
  | { k: "not_connected"; dep: DependencyId; detail: string };

/** Not implemented -> visible "not connected"; any other error -> an error toast and back to the button. */
function depError(e: unknown, dep: DependencyId): Phase {
  if (isNotImplemented(e)) return { k: "not_connected", dep, detail: "package not implemented yet" };
  toast.error(`${dep}: ${errorMessage(e)}`);
  return { k: "idle" };
}

export function CredentialStep({
  card,
  onCard,
  enabled,
  step = 3,
  lockedHint = "Finish steps 1 and 2 first.",
}: {
  card: Card | null;
  onCard: (c: Card) => void;
  enabled: boolean;
  step?: number;
  lockedHint?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const cfgOk = publicConfig.issuerUrl && publicConfig.worldAppId.startsWith("app_") && publicConfig.worldAppId.length > 4;

  async function start() {
    setPhase({ k: "preparing" });
    let hc: HolderCommitment;
    let signal: string;
    try {
      const { initCredential, holderCommitFromSeed, commitmentSignal } = await credential();
      await initCredential();
      // s + blinding come from the passkey (HKDF on this phone), so the same passkey always gives the
      // same commitment C: re-enrolling on a new phone is re-signed by the issuer, not refused.
      const seed = bbsSeed();
      if (!seed) {
        toast.error("Unlock your wallet first (the card secret comes from your passkey).");
        return setPhase({ k: "idle" });
      }
      hc = await holderCommitFromSeed(seed.s, seed.blinding);
      signal = commitmentSignal(hc.commitment);
    } catch (e) {
      return setPhase(depError(e, "credential"));
    }
    try {
      const cfg = await buildIdkitRequest(
        { appId: publicConfig.worldAppId, action: publicConfig.worldAction || WORLD_ACTION, signal, environment: publicConfig.worldEnvironment },
        publicConfig.issuerUrl,
      );
      setPhase({ k: "world", cfg, hc });
    } catch (e) {
      setPhase(depError(e, "world-idkit"));
    }
  }

  async function finish(result: unknown, hc: HolderCommitment) {
    setPhase({ k: "issuing" });
    try {
      const sig = await enrolWithIssuer(publicConfig.issuerUrl, result, hc.commitment);
      const issuerPub = await fetchIssuerPublicKey(publicConfig.issuerUrl);
      const { unblind, verifyCard } = await credential();
      const c = await unblind(sig, hc.secret, issuerPub);
      if (!(await verifyCard(c, issuerPub))) throw new Error("card signature did not verify against the issuer key");
      await vaultSet(VAULT.card, c);
      await vaultDelete(VAULT.pendingCommitment);
      onCard(c);
      setPhase({ k: "idle" });
    } catch (e) {
      setPhase(depError(e, isNotImplemented(e) ? "credential" : "issuer"));
    }
  }

  return (
    <Section step={step} title="Prove you're a unique human (World ID)" done={!!card}>
      {card ? (
        <p className="text-sm text-neutral-400">
          Card stored on this phone: tier <b>{card.tier}</b>, epoch <b>{card.epoch}</b>. Payers will only ever learn &ldquo;a World-verified human&rdquo;.
        </p>
      ) : !cfgOk ? (
        <NotConnected id="world-idkit" detail="Set NEXT_PUBLIC_ISSUER_URL and NEXT_PUBLIC_WORLD_APP_ID." />
      ) : (
        <div className="space-y-3">
          {phase.k === "idle" && (
            <Button onClick={start} disabled={!enabled} className="w-full">
              Verify with World ID
            </Button>
          )}
          {phase.k === "preparing" && <p role="status" className="text-sm text-neutral-500">Preparing…</p>}
          {phase.k === "world" && <WorldFlow cfg={phase.cfg} onResult={(r) => finish(r, phase.hc)} onCancel={() => setPhase({ k: "idle" })} />}
          {phase.k === "issuing" && <p role="status" className="text-sm text-neutral-500">Issuing your card…</p>}
          {phase.k === "not_connected" && (
            <>
              <NotConnected id={phase.dep} detail={phase.detail} />
              <Button tone="secondary" onClick={() => setPhase({ k: "idle" })} className="w-full">Retry</Button>
            </>
          )}

          {!enabled && <p className="text-xs text-neutral-500">{lockedHint}</p>}
        </div>
      )}
    </Section>
  );
}
