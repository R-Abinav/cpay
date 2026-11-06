import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import axios from "axios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STANDARD_CID = "QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU";
const POI_CID = "QmZ2MyM6TKxffkv6stuo2hFwmUfs3q4xgMYN164Sje8new";
const CACHE_ROOT = path.join(tmpdir(), "cpay-railgun-artifacts-v1");

function isAllowedPath(cid: string, relative: string): boolean {
  const variant = "(?:0[1-9]|1[0-3])x(?:0[1-9]|1[0-3])";
  if (cid === STANDARD_CID) {
    return new RegExp(`^(?:circuits/${variant}/(?:zkey\\.br|vkey\\.json)|prover/snarkjs/${variant}\\.wasm\\.br)$`).test(relative);
  }
  if (cid === POI_CID) {
    return /^(?:circuits\/(?:03x03|13x13)\/(?:zkey\.br|vkey\.json)|prover\/snarkjs\/(?:03x03|13x13)\.wasm\.br)$/.test(relative);
  }
  return false;
}

export async function GET(_req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path: requestPath } = await context.params;
    const [cid, ...segments] = requestPath;
    const relative = segments.join("/");
    if (!cid || !isAllowedPath(cid, relative)) {
      return NextResponse.json({ error: "Unknown Railgun circuit artifact" }, { status: 404 });
    }
    const key = `${cid}/${relative}`;
    const filePath = path.join(CACHE_ROOT, cid, relative);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(filePath));
    } catch {
      const response = await axios.get<ArrayBuffer>(`https://ipfs-lb.com/ipfs/${key}`, {
        responseType: "arraybuffer",
        timeout: 30_000,
        maxContentLength: 512 * 1024 * 1024,
      });
      const data = new Uint8Array(response.data);
      if (data.byteLength > 512 * 1024 * 1024) return NextResponse.json({ error: "Artifact exceeds the size limit" }, { status: 502 });
      const minimumBytes = relative.endsWith(".json") ? 16 : 1024;
      if (data.byteLength < minimumBytes) {
        return NextResponse.json({ error: "Artifact response is incomplete" }, { status: 502 });
      }
      if (relative.endsWith(".json")) {
        try { JSON.parse(new TextDecoder().decode(data)); }
        catch { return NextResponse.json({ error: "Artifact JSON is invalid" }, { status: 502 }); }
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
      bytes = data;
    }
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new NextResponse(body, {
      headers: {
        "Content-Type": relative.endsWith(".json") ? "application/json" : "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not load Railgun circuit artifact" }, { status: 502 });
  }
}
