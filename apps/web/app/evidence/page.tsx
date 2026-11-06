"use client";
// Public 0G evidence (request IDs, receipts, root hashes). No user data is in these rows.
import { useEffect, useState } from "react";
import { Page } from "../../components/app-shell.js";
import { fetchEvidence } from "../../lib/zg-client.js";

const COLS = ["ts", "kind", "model", "trustMode", "requestId", "receipt", "rootHash", "httpStatus"] as const;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.status === "string") return o.status;
    if (typeof o.verified === "boolean") return o.verified ? "verified" : "unverified";
    return "present";
  }
  return String(v);
}

export default function EvidencePage() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchEvidence().then(setRows, (e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <Page wide>
      <h1 className="sr-only">0G evidence</h1>
      <p className="text-sm text-neutral-400">
        Every 0G call (speech-to-text, intent, voice, storage) with its request ID and receipt. IDs and hashes only: no audio, text or user
        data.
      </p>
      {err && <p role="alert" className="text-sm text-red-300">Evidence unavailable: {err}</p>}
      {rows === null && !err && <p className="text-neutral-500">Loading…</p>}
      {rows && rows.length === 0 && <p className="text-neutral-500">No 0G calls recorded yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto border-y border-neutral-900">
          <table className="w-full text-left text-xs">
            <thead className="text-neutral-500">
              <tr>
                {COLS.map((c) => (
                  <th key={c} className="px-3 py-2 font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-neutral-900">
                  {COLS.map((c) => (
                    <td key={c} className="whitespace-nowrap px-3 py-2">
                      {cell(r[c] ?? (c === "requestId" ? r.request_id : c === "rootHash" ? r.root_hash : undefined))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
