"use client";
// World ID step: passkey-derived BBS commitment -> World IDKit (Proof of Human, signal = hash(C), RP signature from the issuer)
// -> issuer /enrol (verifies with World, stores the nullifier, blind-signs) -> unblind -> verify -> store the card.
// Uses the headless IDKit hook (the stock widget pulls fonts from a CDN, which CROPS forbids).
import { useEffect, useState } from "react";
import {
  commitmentSignal,
  holderCommitFromSeed,
  initCredential,
  unblind,
  verifyCard,
  type Card,
  type HolderCommitment,
} from "@cpay/credential";
import { WORLD_ACTION, buildIdkitRequest, type IdkitRequestConfig } from "@cpay/world";
import { proofOfHuman, useIDKitRequest, type RpContext } from "@worldcoin/idkit/hooks";
import QRCode from "qrcode";
import { Button, ErrorNote, Mono, NotConnected, Section } from "../../components/ui.js";
import { errorMessage, isNotImplemented, type DependencyId } from "../../lib/deps.js";
import { enrolWithIssuer, fetchIssuerPublicKey } from "../../lib/issuer-client.js";
import { publicConfig } from "../../lib/public-config.js";
import { VAULT, vaultDelete, vaultSet } from "../../lib/vault.js";
import { bbsSeed } from "../../lib/wallet.js";

type Phase =
  | { k: "idle" }
  | { k: "preparing" }
  | { k: "world"; cfg: IdkitRequestConfig; hc: HolderCommitment }
  | { k: "issuing" }
  | { k: "not_connected"; dep: DependencyId; detail: string }
  | { k: "error"; message: string };

function depError(e: unknown, dep: DependencyId): Phase {
  if (isNotImplemented(e)) return { k: "not_connected", dep, detail: "package not implemented yet" };
  return { k: "error", message: `${dep}: ${errorMessage(e)}` };
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
      await initCredential();
      // s + blinding come from the passkey (HKDF on this phone), so the same passkey always gives the
      // same commitment C: re-enrolling on a new phone is re-signed by the issuer, not refused.
      const seed = bbsSeed();
      if (!seed) return setPhase({ k: "error", message: "Unlock your wallet first (the card secret comes from your passkey)." });
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
          {phase.k === "preparing" && <p className="text-sm text-neutral-400">Creating your hidden credential secret…</p>}
          {phase.k === "world" && <WorldFlow cfg={phase.cfg} onResult={(r) => finish(r, phase.hc)} onCancel={() => setPhase({ k: "idle" })} />}
          {phase.k === "issuing" && <p className="text-sm text-neutral-400">Issuer is checking your proof and blind-signing your card…</p>}
          {phase.k === "not_connected" && (
            <>
              <NotConnected id={phase.dep} detail={phase.detail} />
              <Button tone="secondary" onClick={() => setPhase({ k: "idle" })} className="w-full">Retry</Button>
            </>
          )}
          {phase.k === "error" && (
            <>
              <ErrorNote>{phase.message}</ErrorNote>
              <Button tone="secondary" onClick={() => setPhase({ k: "idle" })} className="w-full">Retry</Button>
            </>
          )}
          {!enabled && <p className="text-xs text-neutral-500">{lockedHint}</p>}
        </div>
      )}
    </Section>
  );
}

function WorldFlow({ cfg, onResult, onCancel }: { cfg: IdkitRequestConfig; onResult: (r: unknown) => void; onCancel: () => void }) {
  const flow = useIDKitRequest({
    app_id: cfg.appId as `app_${string}`,
    action: cfg.action,
    rp_context: cfg.rpSignature as RpContext,
    allow_legacy_proofs: false,
    environment: cfg.environment,
    preset: proofOfHuman({ signal: cfg.signal }),
  });
  const [qr, setQr] = useState<string | null>(null);
  const [delivered, setDelivered] = useState(false);

  useEffect(() => {
    flow.open();
    // open once per mounted flow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (flow.connectorURI) QRCode.toDataURL(flow.connectorURI, { margin: 1, width: 280 }).then(setQr, () => setQr(null));
  }, [flow.connectorURI]);
  useEffect(() => {
    if (flow.result && !delivered) {
      setDelivered(true);
      onResult(flow.result);
    }
  }, [flow.result, delivered, onResult]);

  if (flow.isError) {
    return (
      <div className="space-y-3">
        <ErrorNote>World ID: {flow.errorCode ?? "error"}</ErrorNote>
        <Button tone="secondary" onClick={onCancel} className="w-full">Back</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {flow.isAwaitingUserConfirmation ? (
        <p className="text-sm text-neutral-300">Confirm in World App…</p>
      ) : flow.connectorURI ? (
        <>
          <a href={flow.connectorURI} className="block min-h-12 rounded-xl bg-white px-5 py-3 text-center font-semibold text-black">
            Open World App
          </a>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="World ID request QR" className="mx-auto w-56 rounded-lg bg-white p-2" />
          )}
          {cfg.environment === "staging" && (
            <p className="text-xs text-neutral-500">
              Staging: paste this request into the World simulator. <Mono>{flow.connectorURI}</Mono>
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-neutral-400">Connecting to World…</p>
      )}
      <Button tone="secondary" onClick={onCancel} className="w-full">Cancel</Button>
    </div>
  );
}
