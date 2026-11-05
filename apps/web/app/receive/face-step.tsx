"use client";
// Step 2: face enrolment. 5+ selfie captures -> embeddings (on-device) -> buildTemplate -> encrypted vault.
// Frames and embeddings exist only in memory here; only the template is stored, and never uploaded.
import { useEffect, useRef, useState } from "react";
import { MIN_ENROLMENT_EMBEDDINGS, buildTemplate } from "@cpay/protocol";
import { Button, ErrorNote, NotConnected, Section } from "../../components/ui.js";
import { errorMessage } from "../../lib/deps.js";
import { FACE_MODEL_ID, embedFace, loadFaceEngine } from "../../lib/face/engine.js";
import { VAULT, vaultSet } from "../../lib/vault.js";

export interface StoredTemplate {
  v: 1;
  model: string;
  template: number[];
  captures: number;
}

const TARGET = Math.max(MIN_ENROLMENT_EMBEDDINGS, 6);
const MAX_ATTEMPTS = 24;

export function FaceStep({ template, onTemplate }: { template: StoredTemplate | null; onTemplate: (t: StoredTemplate | null) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  async function startCamera() {
    setErr(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setErr("Camera needs HTTPS (secure context). Open this page over https://.");
      return;
    }
    try {
      loadFaceEngine().catch((e) => setModelErr(errorMessage(e)));
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play();
      }
      setCamOn(true);
    } catch (e) {
      setErr(`camera: ${errorMessage(e)}`);
    }
  }

  function stopCamera() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamOn(false);
  }

  async function capture() {
    const v = video.current;
    if (!v) return;
    setBusy(true);
    setErr(null);
    const embeddings: Float32Array[] = [];
    try {
      for (let i = 0; i < MAX_ATTEMPTS && embeddings.length < TARGET; i++) {
        const r = await embedFace(v, v.videoWidth, v.videoHeight, "largest");
        if (r) {
          embeddings.push(r.embedding);
          setCount(embeddings.length);
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      if (embeddings.length < MIN_ENROLMENT_EMBEDDINGS) {
        setErr(`Only found a face in ${embeddings.length} of ${MAX_ATTEMPTS} frames. Face the camera in good light and try again.`);
        return;
      }
      const t = buildTemplate(embeddings);
      const stored: StoredTemplate = { v: 1, model: FACE_MODEL_ID, template: Array.from(t), captures: embeddings.length };
      await vaultSet(VAULT.template, stored);
      embeddings.length = 0;
      stopCamera();
      onTemplate(stored);
    } catch (e) {
      setModelErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section step={2} title="Enrol your face (stays on this phone)" done={!!template}>
      {template ? (
        <div className="space-y-3">
          <p className="text-sm text-neutral-400">
            Template from {template.captures} captures, encrypted on this phone. Model: <code>{template.model}</code>.
          </p>
          <Button tone="secondary" onClick={() => onTemplate(null)} className="w-full">Re-enrol</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-xl bg-black">
            {/* mirrored preview only; captured pixels are not mirrored */}
            <video ref={video} playsInline muted className={`aspect-[4/3] w-full -scale-x-100 object-cover ${camOn ? "" : "hidden"}`} />
            {!camOn && <div className="grid aspect-[4/3] place-items-center text-sm text-neutral-500">camera off</div>}
          </div>
          {camOn ? (
            <Button onClick={capture} disabled={busy} className="w-full">
              {busy ? `Capturing… ${count}/${TARGET}` : `Capture ${TARGET} frames`}
            </Button>
          ) : (
            <Button onClick={startCamera} className="w-full">Start camera</Button>
          )}
          <p className="text-xs text-neutral-500">Hold still, look at the camera, small head turns are fine. Photos are never saved.</p>
          {modelErr && <NotConnected id="face-model" detail={modelErr} />}
        </div>
      )}
      {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
    </Section>
  );
}
