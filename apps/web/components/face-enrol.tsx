"use client";
// Face enrolment (onboarding, Settings). Re-enrol keeps the current template until a new capture is saved.
// 5+ selfie captures -> embeddings ON THIS PHONE
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
    <ul className="space-y-1.5 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4 text-xs leading-relaxed text-neutral-400">
      <li>Your face becomes 128 numbers, not a photo. Encrypted on this phone, never uploaded.</li>
      <li>Your phone answers a glasses scan only if it matches you; otherwise it stays silent.</li>
      <li>A match reveals only &ldquo;World-verified human&rdquo; and a fresh one-time address.</li>
      <li>A glasses scan sends a sealed face code to every CPay phone online; each compares it and drops it. Go invisible on Receive anytime.</li>
    </ul>
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
  title = "Face pay",
  bare = false,
}: {
  template: StoredTemplate | null;
  onTemplate: (t: StoredTemplate | null) => void;
  step?: number;
  title?: string;
  bare?: boolean;
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
  // Re-enrolling: the old template stays stored (and in use) until the new capture is saved over it.
  const [redo, setRedo] = useState(false);
  const capturing = !template || redo;

  const mounted = useRef(true);

  function stopCamera() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    if (mounted.current) setCamOn(false);
  }

  // Warm the self-hosted face model while the user reads the disclosure (no camera involved).
  useEffect(() => {
    if (!capturing) return;
    setModel((m) => (m === "ready" ? m : "loading"));
    loadFaceEngine().then(
      () => mounted.current && setModel("ready"),
      () => mounted.current && setModel("idle"), // startCamera retries and reports the error
    );
  }, [capturing]);

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
          setHint("Hold still…");
        } else {
          setHint("Move closer, face the camera, add light");
        }
        await new Promise((res) => setTimeout(res, GAP_MS));
      }
      if (embeddings.length < MIN_ENROLMENT_EMBEDDINGS) {
        setErr(`Couldn't see your face clearly (${embeddings.length}/${TARGET}). Face the camera in good light and try again.`);
        return;
      }
      const t = buildTemplate(embeddings);
      const stored: StoredTemplate = { v: 1, model: FACE_MODEL_ID, template: Array.from(t), captures: embeddings.length };
      await vaultSet(VAULT.template, stored); // overwrites the old template only now
      enrolled = true;
      stopCamera();
      setRedo(false);
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

  function cancelRedo() {
    stopCamera();
    setRedo(false);
    setErr(null);
    setModelErr(null);
    setCount(0);
  }

  function remove() {
    if (confirm("Remove your face from this phone? Face pay turns off until you enrol again.")) onTemplate(null);
  }

  return (
    <Section step={step} title={title} done={!!template} bare={bare}>
      {template && !redo ? (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-300" aria-hidden>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="font-semibold">Face enrolled</p>
              <p className="text-xs text-neutral-500">Encrypted on this phone only</p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button tone="secondary" onClick={() => setRedo(true)} className="flex-1">
              Re-enrol face
            </Button>
            <Button tone="danger" onClick={remove} className="px-4">
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {redo ? (
            <p className="text-sm text-neutral-400">Your current face stays until the new one is saved.</p>
          ) : bare ? (
            <details className="group rounded-2xl border border-neutral-800 px-4 text-xs text-neutral-300">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between font-medium text-neutral-300">
                What face pay shares
                <span className="text-neutral-600 transition-transform group-open:rotate-90" aria-hidden>›</span>
              </summary>
              <div className="pb-3 [&>ul]:border-0 [&>ul]:bg-transparent [&>ul]:p-0">
                <FaceDisclosure />
              </div>
            </details>
          ) : (
            <FaceDisclosure />
          )}
          <div className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-black">
            {/* mirrored preview only; captured pixels are not mirrored */}
            <video ref={video} playsInline muted className={`aspect-[4/3] max-h-[32dvh] w-full -scale-x-100 object-cover ${camOn ? "" : "hidden"}`} />
            {!camOn && <div className="grid aspect-[4/3] max-h-[32dvh] w-full place-items-center text-sm text-neutral-600">Camera off</div>}
          </div>
          {camOn && (busy || count > 0) && (
            <div className="space-y-1.5" role="status" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(count / TARGET) * 100}%` }} />
              </div>
              <p className="text-sm text-neutral-400">
                {count}/{TARGET}
                {hint ? ` · ${hint}` : ""}
              </p>
            </div>
          )}
          {camOn ? (
            <Button onClick={capture} disabled={busy || model !== "ready"} className="w-full">
              {model !== "ready" ? "Loading face model…" : busy ? `Capturing… ${count}/${TARGET}` : "Capture my face"}
            </Button>
          ) : (
            <Button onClick={startCamera} className="w-full">Start camera</Button>
          )}
          {redo ? (
            <Button tone="secondary" onClick={cancelRedo} disabled={busy} className="w-full">
              Cancel, keep current face
            </Button>
          ) : (
            <p className="text-center text-xs text-neutral-500">Look at the camera and hold still. No photos are saved.</p>
          )}
          {modelErr && <NotConnected id="face-model" detail={modelErr} />}
        </div>
      )}
      {err && <div className="mt-3"><ErrorNote>{err}</ErrorNote></div>}
    </Section>
  );
}
