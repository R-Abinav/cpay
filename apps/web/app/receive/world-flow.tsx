"use client";
// World IDKit flow (headless hook; the stock widget pulls CDN fonts, which CROPS forbids). Split out of
// credential-step so IDKit and the QR encoder load only when the World step actually starts.
import { useEffect, useState } from "react";
import type { IdkitRequestConfig } from "@cpay/world";
import { proofOfHuman, useIDKitRequest, type RpContext } from "@worldcoin/idkit/hooks";
import { Button, ErrorNote, Mono } from "../../components/ui.js";

export function WorldFlow({ cfg, onResult, onCancel }: { cfg: IdkitRequestConfig; onResult: (r: unknown) => void; onCancel: () => void }) {
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
    if (flow.connectorURI) {
      const uri = flow.connectorURI;
      import("qrcode").then((Q) => Q.default.toDataURL(uri, { margin: 1, width: 280 })).then(setQr, () => setQr(null));
    }
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
            <img src={qr} alt="World ID request QR" className="mx-auto max-h-[26dvh] w-auto max-w-56 rounded-lg bg-white p-2" />
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
