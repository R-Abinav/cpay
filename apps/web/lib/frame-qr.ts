"use client";
// Decode a QR from one glasses frame (base64 JPEG) on the phone. Pixels stay in this function's canvas and
// are dropped after decode; nothing is stored or sent anywhere.
// jsQR (~250 KB) loads on the first decode, not with the Pay tab.
let jsqr: Promise<typeof import("jsqr").default> | null = null;
const loadJsQr = () => (jsqr ??= import("jsqr").then((m) => m.default));

let canvas: HTMLCanvasElement | null = null;

function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function frameBlob(dataBase64: string, mime = "image/jpeg"): Blob {
  return b64ToBlob(dataBase64, mime);
}

async function toImage(blob: Blob): Promise<CanvasImageSource & { width: number; height: number; close?: () => void }> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Returns the QR text or null. */
export async function decodeQrFromJpeg(blob: Blob): Promise<string | null> {
  const jsQR = await loadJsQr();
  const img = await toImage(blob);
  try {
    canvas ??= document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const c = canvas.getContext("2d", { willReadFrequently: true });
    if (!c) return null;
    c.drawImage(img, 0, 0);
    const data = c.getImageData(0, 0, img.width, img.height);
    // The glasses camera can see printed (dark-on-light) and screen (often inverted) QRs.
    const code = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
    c.clearRect(0, 0, img.width, img.height);
    return code?.data ? code.data.trim() : null;
  } finally {
    img.close?.();
  }
}
