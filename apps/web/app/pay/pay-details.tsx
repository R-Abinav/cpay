"use client";
// Collapsed details under the Pay stage: privacy X-ray (this session's real data only), 0G evidence
// (request IDs + receipts, for judges), and the scan log. Never image data, transcripts or full addresses.
import Link from "next/link";
import { Details } from "../../components/ui.js";
import type { PayState } from "../../lib/pay-machine.js";
import type { PayView } from "./controller.js";

function xray(st: PayState): string[] | null {
  if (!("recipient" in st)) return null;
  const r = st.recipient;
  if (r.kind === "address")
    return [
      "Recipient: the public address on the QR (not verified).",
      "On-chain: anyone can link this payment to that address and to your agent wallet.",
      "0G got only your spoken amount, never the address.",
    ];
  if (r.kind === "private")
    return [
      `Recipient: a fresh one-time address, proof checked on this phone (World ID ${r.tier}).`,
      "You learn only “verified human”, not who they are. They see your agent wallet as the payer on-chain.",
      "0G got only your spoken amount, never the address.",
    ];
  return ["Recipient not verified yet: nothing is paid until its proof checks out on this phone."];
}

export function PayDetails({ view }: { view: PayView }) {
  const x = xray(view.state);
  return (
    <Details summary="Details">
      {x && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">Privacy X-ray</h3>
          <ul className="space-y-1 text-sm text-neutral-300">
            {x.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">0G evidence (this payment)</h3>
        {view.evidence.length === 0 ? (
          <p className="text-sm text-neutral-500">No 0G calls yet.</p>
        ) : (
          <ul className="space-y-1 font-mono text-xs text-neutral-300">
            {view.evidence.map((e, i) => (
              <li key={i} className="break-all">
                {e.kind} · {e.requestId ?? "(no request id)"} · receipt {e.receipt}
              </li>
            ))}
          </ul>
        )}
        <Link href="/evidence" className="mt-2 inline-block min-h-11 py-2 text-sm text-neutral-400 underline">
          All 0G evidence
        </Link>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
          Scan log · {view.stats.frames} frames · {view.stats.drops} drops · {view.stats.fps} fps
        </h3>
        <ol className="space-y-1 font-mono text-xs text-neutral-400">
          {view.log.length === 0 && <li className="text-neutral-600">Empty.</li>}
          {view.log.map((l, i) => (
            <li key={i} className="break-words">
              <span className="text-neutral-600">{l.ts}</span>{" "}
              {l.href ? (
                <a href={l.href} target="_blank" rel="noreferrer noopener" className="text-emerald-300 underline">
                  {l.text}
                </a>
              ) : (
                l.text
              )}
            </li>
          ))}
        </ol>
      </div>

      <ul className="space-y-1 text-xs text-neutral-500">
        <li>The camera streams only after you tap Scan, stops at the first QR, and runs at most 30 s.</li>
        <li>The mic records only the amount (max 8 s) and the 5 s confirm window. Audio is never stored.</li>
        <li>The confirm code is shown only on your glasses. This phone signs; no server holds your key.</li>
        <li>The glasses hub forwards frames in memory only (not end-to-end encrypted yet).</li>
      </ul>
    </Details>
  );
}
