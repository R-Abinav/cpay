"use client";
// QR claim fallback (NO VERIFIED RECIPIENT on the payer side): the payer shows a QR / short code for its open
// session; this phone already received that session's sealed probe, so the owner can explicitly claim it.
// Same claim as the face path: fresh one-time destination + BBS proof bound to bindingDigest. Decoded on-device (jsQR).
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Button, ErrorNote } from "../../components/ui.js";
import { errorMessage } from "../../lib/deps.js";
import { findProbeForCode, type OpenedProbe } from "../../lib/recipient.js";
import { formatAmount } from "../../lib/units.js";

export function QrClaim({ probes, onClaim, disabled }: { probes: OpenedProbe[]; onClaim: (p: OpenedProbe) => Promise<void>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [found, setFound] = useState<OpenedProbe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  function stopScan() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setScanning(false);
  }
  useEffect(() => () => stopScan(), []);

  function resolve(input: string) {
    const p = findProbeForCode(probes, input);
    if (!p) {
      setErr("No probe for that code reached this phone in the last minute. Make sure you were visible when the payer looked.");
      return false;
    }
    setErr(null);
    setFound(p);
    return true;
  }

  async function scan() {
    setErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      stream.current = s;
      setScanning(true);
      const v = video.current!;
      v.srcObject = s;
      await v.play();
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      const tick = () => {
        if (!stream.current) return;
        if (v.videoWidth) {
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (r?.data) {
            stopScan();
            resolve(r.data);
            return;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      stopScan();
      setErr(`camera: ${errorMessage(e)}`);
    }
  }

  async function claim() {
    if (!found) return;
    try {
      await onClaim(found);
      setDone(true);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  if (!open) {
    return (
      <Button tone="secondary" className="w-full" onClick={() => setOpen(true)} disabled={disabled}>
        Payer says &ldquo;no verified recipient&rdquo;? Claim with QR
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-2xl border border-neutral-700 p-3">
      {done ? (
        <p className="text-emerald-300">Claim sent. The payer still has to verify your proof and press CONFIRM.</p>
      ) : found ? (
        <>
          <p>
            Claim <b>{formatAmount(BigInt(found.body.amount), 6)} USDC</b> from this payer?
          </p>
          <Button onClick={claim} className="w-full">Claim</Button>
        </>
      ) : (
        <>
          <video ref={video} playsInline muted className={`w-full rounded-xl ${scanning ? "" : "hidden"}`} />
          {!scanning && <Button onClick={scan} className="w-full">Scan payer&apos;s QR</Button>}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              resolve(code);
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="or type code"
              inputMode="text"
              autoCapitalize="characters"
              className="min-h-12 flex-1 rounded-xl bg-neutral-800 px-3 font-mono uppercase"
            />
            <Button type="submit" tone="secondary">Find</Button>
          </form>
        </>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
      <Button
        tone="secondary"
        className="w-full"
        onClick={() => {
          stopScan();
          setOpen(false);
          setFound(null);
          setDone(false);
          setCode("");
        }}
      >
        Close
      </Button>
    </div>
  );
}
