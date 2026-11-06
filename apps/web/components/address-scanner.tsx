"use client";
// Phone-camera QR scan for a recipient address (used by "Send privately"). The camera starts only on tap,
// stops the moment a QR is read, and after 30 s at most. Frames are decoded on the phone with jsQR and dropped;
// nothing is stored or sent.
import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

const MAX_MS = 30_000;

export function AddressScanner({ onText, onClose }: { onText: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    const timer = setTimeout(() => {
      stop();
      setErr("No QR found in 30 s.");
    }, MAX_MS);

    const tick = () => {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        const c = canvas.getContext("2d", { willReadFrequently: true });
        if (c) {
          c.drawImage(v, 0, 0);
          const img = c.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
          c.clearRect(0, 0, canvas.width, canvas.height);
          if (code?.data) {
            clearTimeout(timer);
            stop();
            onText(code.data.trim());
            return;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setErr("Camera needs HTTPS. Paste the address instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) return stop();
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setErr(`Camera: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [onText]);

  return (
    <div className="mt-2 rounded-xl bg-neutral-950 p-2">
      <video ref={video} playsInline muted className="aspect-square w-full rounded-lg bg-black object-cover" />
      {err && <p className="mt-2 text-sm text-amber-200">{err}</p>}
      <button onClick={onClose} className="mt-2 min-h-11 w-full rounded-lg bg-neutral-800 px-3 text-sm font-semibold">
        Stop camera
      </button>
    </div>
  );
}
