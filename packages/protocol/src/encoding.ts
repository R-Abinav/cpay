// Small, dependency-free byte encoders (no crypto here). Work in Node 22+ and browsers.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export { bytesToHex, hexToBytes };

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Float32 embedding -> base64 of its little-endian IEEE-754 bytes. */
export function encodeEmbedding(embedding: ArrayLike<number>): string {
  const f = Float32Array.from(embedding);
  const view = new DataView(new ArrayBuffer(f.length * 4));
  f.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return bytesToBase64(new Uint8Array(view.buffer));
}

export function decodeEmbedding(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  if (bytes.length === 0 || bytes.length % 4 !== 0) throw new Error("embedding: bad length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
