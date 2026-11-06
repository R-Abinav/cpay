"use client";
// Face enrolment (onboarding, Receive, Settings "re-enrol"). 5+ selfie captures -> embeddings ON THIS PHONE
// -> buildTemplate -> encrypted on-device vault. Frames and embeddings exist only in memory here; only the
// template is stored, and it is never uploaded or sent anywhere.
import { useEffect, useRef, useState } from "react";
import { MIN_ENROLMENT_EMBEDDINGS, buildTemplate } from "@cpay/protocol";
import { Button, ErrorNote, NotConnected, Section } from "./ui.js";
import { errorMessage } from "../lib/deps.js";
import { FACE_MODEL_ID, embedFace, loadFaceEngine } from "../lib/face/engine.js";
import { getRecipient, type StoredTemplate } from "../lib/recipient-service.js";
import { VAULT, vaultDelete, vaultGet, vaultSet } from "../lib/vault.js";

export type { StoredTemplate };

const TARGET = MIN_ENROLMENT_EMBEDDINGS; // 5 good frames (the protocol minimum)
const MAX_ATTEMPTS = 30;
const GAP_MS = 120;

/** What enrolling means for privacy. Shown before the camera starts. */
export function FaceDisclosure() {
  return (
    <div className="space-y-1 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-neutral-300">
      <p className="font-semibold text-sky-200">What face pay shares</p>
      <p>
        Your face template (128 numbers, not a photo) is made and kept on this phone, encrypted. It is never uploaded.
      </p>
      <p>
        When someone with CPay glasses looks at a face and taps Scan, their phone sends that face&apos;s embedding, sealed, to every
        CPay phone online on the relay. Yours compares it with your template here and answers only on a match; otherwise it stays
        silent. Likewise, while you are visible, your phone receives other people&apos;s sealed probe embeddings and drops each one
        after a single compare.
      </p>
      <p>A match reveals only that you are a World-verified human and a fresh one-time address. Go invisible on Receive anytime.</p>
    </div>
  );
}

/** Loads the stored template (only if it was made by the current model). */
export function useStoredTemplate(): [StoredTemplate | null | undefined, (t: StoredTemplate | null) => Promise<void>] {
  const [t, setT] = useState<StoredTemplate | null | undefined>(undefined);
  useEffect(() => {
    vaultGet<StoredTemplate>(VAULT.template).then(
      (v) => setT(v && v.model === FACE_MODEL_ID ? v : null),
      () => setT(null),
    );
  }, []);
  async function change(next: StoredTemplate | null) {
    if (!next) await vaultDelete(VAULT.template);
    setT(next);
    void getRecipient().start();
  }
  return [t, change];
}

export function FaceEnrol({
  template,
  onTemplate,
  step,
  title = "Enrol your face (stays on this phone)",
}: {
  template: StoredTemplate | null;
  onTemplate: (t: StoredTemplate | null) => void;
  step?: number;
  title?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [modelErr, setModelErr] = useState<string | null>(null);
  // Feedback while capturing, so the page never looks frozen: model loading, frames tried, face seen or not.
  const [model, setModel] = useState<"idle" | "loading" | "ready">("idle");
  const [tries, setTries] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const mounted = useRef(true);

  function stopCamera() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    if (mounted.current) setCamOn(false);
  }

  // Warm the self-hosted face model while the user reads the disclosure (no camera involved).
  useEffect(() => {
    if (template) return;
    setModel("loading");
    loadFaceEngine().then(
      () => mounted.current && setModel("ready"),
      () => mounted.current && setModel("idle"), // startCamera retries and reports the error
    );
  }, [template]);

  // Unmount: camera off, always.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCamera() {
    setErr(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setErr("Camera needs HTTPS (secure context). Open this page over https://.");
      return;
    }
    let engineFailed = false;
    try {
      setModel((m) => (m === "ready" ? m : "loading"));
      loadFaceEngine().then(
        () => mounted.current && setModel("ready"),
        (e) => {
        engineFailed = true;
        stopCamera(); // no model -> no capture: don't leave the camera running
        if (mounted.current) setModelErr(errorMessage(e));
        },
      );
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      stream.current = s;
      // Unmounted while the permission prompt was open, or the model already failed: camera off.
      if (!mounted.current || engineFailed) return stopCamera();
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play();
      }
      setCamOn(true);
    } catch (e) {
      stopCamera();
      setErr(`camera: ${errorMessage(e)}`);
    }
  }

  async function capture() {
    const v = video.current;
    if (!v) return;
    setBusy(true);
    setErr(null);
    setCount(0);
    setTries(0);
    setHint("Looking for your face…");
    const embeddings: Float32Array[] = [];
    let enrolled = false;
    try {
      for (let i = 0; i < MAX_ATTEMPTS && embeddings.length < TARGET; i++) {
        const r = await embedFace(v, v.videoWidth, v.videoHeight, "largest");
        if (!mounted.current) return;
        setTries(i + 1);
        if (r) {
          embeddings.push(r.embedding);
          setCount(embeddings.length);
          setHint("Got it, hold still…");
        } else {
          setHint("No face seen: move closer, face the camera, add light.");
        }
        await new Promise((res) => setTimeout(res, GAP_MS));
      }
      if (embeddings.length < MIN_ENROLMENT_EMBEDDINGS) {
        setErr(`Only found a face in ${embeddings.length} of ${MAX_ATTEMPTS} frames. Face the camera in good light and try again.`);
        return;
      }
      const t = buildTemplate(embeddings);
      const stored: StoredTemplate = { v: 1, model: FACE_MODEL_ID, template: Array.from(t), captures: embeddings.length };
      await vaultSet(VAULT.template, stored);
      enrolled = true;
      stopCamera();
      onTemplate(stored);
    } catch (e) {
      setModelErr(errorMessage(e));
    } finally {
      // Any failed capture (too few faces, model or vault error) turns the camera off; "Start camera" retries.
      if (!enrolled) stopCamera();
      for (const e of embeddings) e.fill(0);
      embeddings.length = 0;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Section step={step} title={title} done={!!template}>
      {template ? (
        <div className="space-y-3">
          <p className="text-sm text-neutral-400">
            Template from {template.captures} captures, encrypted on this phone. Model: <code>{template.model}</code>.
          </p>
          <Button tone="secondary" onClick={() => onTemplate(null)} className="w-full">Re-enrol face</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <FaceDisclosure />
          <div className="relative overflow-hidden rounded-xl bg-black">
            {/* mirrored preview only; captured pixels are not mirrored */}
            <video ref={video} playsInline muted className={`aspect-[4/3] w-full -scale-x-100 object-cover ${camOn ? "" : "hidden"}`} />
            {!camOn && <div className="grid aspect-[4/3] place-items-center text-sm text-neutral-500">camera off</div>}
          </div>
          {camOn && (busy || count > 0) && (
            <div className="space-y-1" role="status" aria-live="polite">
              <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(count / TARGET) * 100}%` }} />
              </div>
              <p className="text-sm text-neutral-300">
                {count}/{TARGET} captured · {tries}/{MAX_ATTEMPTS} frames checked{hint ? ` · ${hint}` : ""}
              </p>
            </div>
          )}
          {camOn ? (
            <Button onClick={capture} disabled={busy || model !== "ready"} className="w-full">
              {model !== "ready"
                ? "Loading face model… (first time only)"
                : busy
                  ? `Capturing… ${count}/${TARGET}`
                  : `Capture ${TARGET} frames`}
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
