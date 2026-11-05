"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** QR generated on the phone (no external service). */
export function AddressQr({ value, size = 220 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { margin: 1, width: size, errorCorrectionLevel: "M" }).then((u) => live && setSrc(u), () => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [value, size]);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} width={size} height={size} alt="Top-up QR for your agent wallet" className="rounded-lg bg-white p-2" />
  ) : (
    <div style={{ width: size, height: size }} className="rounded-lg bg-neutral-800" />
  );
}
