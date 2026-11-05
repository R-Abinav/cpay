"use client";
import type { ReactNode } from "react";
import { Mono, Section, short } from "../../components/ui.js";
import { ETHERSCAN_ADDR, ETHERSCAN_TX } from "../../lib/public-config.js";
import { formatAmount } from "../../lib/units.js";
import type { RunView } from "./run-view.js";

/** 0G asked to see this: request ID + receipt status of every 0G call in this payment, plus the Storage root hash. */
export function EvidencePanel({ run }: { run: RunView | null }) {
  const ev = run?.evidence ?? [];
  return (
    <Section title="0G evidence (this payment)">
      {ev.length === 0 ? (
        <p className="text-sm text-neutral-500">No 0G calls yet in this run.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1 pr-2">call</th>
                <th className="py-1 pr-2">model</th>
                <th className="py-1 pr-2">mode</th>
                <th className="py-1 pr-2">HTTP</th>
                <th className="py-1 pr-2">request ID</th>
                <th className="py-1">receipt</th>
              </tr>
            </thead>
            <tbody>
              {ev.map((e, i) => (
                <tr key={`${e.ts}-${i}`} className="border-t border-neutral-800 align-top">
                  <td className="py-1 pr-2 font-semibold">{e.kind}</td>
                  <td className="py-1 pr-2">{e.model}</td>
                  <td className={`py-1 pr-2 ${e.trustMode === "private" ? "text-emerald-300" : "text-amber-300"}`}>{e.trustMode}</td>
                  <td className="py-1 pr-2">{e.httpStatus ?? "–"}</td>
                  <td className="py-1 pr-2">
                    {e.requestId ? <Mono>{e.requestId}</Mono> : <span className="text-red-300">missing</span>}
                  </td>
                  <td className="py-1">
                    {e.receipt ? <span className="text-emerald-300">present</span> : <span className="text-amber-300">missing</span>}
                    {e.rawTrace ? <span className="ml-1 text-neutral-500">(+trace)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 text-xs">
        <span className="text-neutral-500">0G Storage root hash: </span>
        {run?.rootHash ? <Mono>{run.rootHash}</Mono> : <span className="text-neutral-500">{run?.episodeError ?? "not logged yet"}</span>}
        {run?.storageTxHash && (
          <div>
            <span className="text-neutral-500">storage tx: </span>
            <Mono>{run.storageTxHash}</Mono>
          </div>
        )}
      </div>
    </Section>
  );
}

function Row({ who, saw, tone = "neutral" }: { who: string; saw: ReactNode; tone?: "neutral" | "leak" | "none" }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 border-t border-neutral-800 py-2 text-sm first:border-t-0">
      <div className="font-semibold">{who}</div>
      <div className={tone === "leak" ? "text-amber-200" : tone === "none" ? "text-emerald-300" : "text-neutral-300"}>{saw}</div>
    </div>
  );
}

/** Privacy X-ray: what each party saw in the last payment. Only data recorded during this run. */
export function XrayPanel({ run }: { run: RunView | null }) {
  if (!run) {
    return (
      <Section title="Privacy X-ray">
        <p className="text-sm text-neutral-500">Make a payment to see exactly what each party learned.</p>
      </Section>
    );
  }
  const amt = run.intent ? `${run.intent.amount} ${run.intent.symbol}` : "–";
  const zg = run.evidence.filter((e) => e.kind !== "storage");
  const store = run.evidence.filter((e) => e.kind === "storage");
  return (
    <Section title="Privacy X-ray (last payment)">
      <Row
        who="You (payer)"
        saw={
          run.verified ? (
            <>
              &ldquo;a World-verified human&rdquo; (tier {run.verified.tier}, epoch {run.verified.epoch}) + one-time address{" "}
              <Mono>{run.destination ? short(run.destination) : "–"}</Mono>. No name, no wallet, no face template.
            </>
          ) : (
            "no recipient revealed in this run"
          )
        }
      />
      <Row
        who="Issuer"
        tone={run.issuerRequests === 0 ? "none" : "neutral"}
        saw={
          run.issuerRequests === 0
            ? "nothing: no request reached the issuer during this payment"
            : `${run.issuerRequests} request(s) for its public key (no payment data)`
        }
      />
      <Row
        who="Relay"
        saw={
          run.relay.probeAt
            ? `ciphertext only: one probe fanned out to ${run.relay.peers} phone(s) (${run.relay.probeBytes} B), ${run.relay.claims} sealed claim(s) back (${run.relay.claimBytes} B), timing`
            : "nothing yet"
        }
      />
      <Row
        who="Nearby phones"
        tone={run.relay.peers ? "leak" : "neutral"}
        saw={
          run.relay.peers
            ? `${run.relay.peers} enrolled phone(s) each opened the sealed face embedding (128 numbers), compared locally, discarded it. Known leak, disclosed. ${Math.max(0, run.relay.peers - run.relay.claims)} stayed silent.`
            : "none probed"
        }
      />
      <Row
        who="Glasses / bridge"
        saw={
          run.frame.source
            ? `one ${run.frame.source} frame (${run.frame.bytes} B, ${run.frame.faces} face(s)), turned into an embedding on this laptop, ${run.frame.deleted ? "then deleted" : "pending"}`
            : "no frame"
        }
      />
      <Row
        who="0G (private)"
        saw={
          zg.length
            ? `${zg.filter((e) => e.trustMode === "private").length} private-mode call(s) (voice clip + intent text inside a TEE): ${zg
                .filter((e) => e.trustMode === "private")
                .map((e) => e.kind)
                .join(", ") || "–"}`
            : "no calls"
        }
      />
      <Row
        who="0G (TTS)"
        tone={zg.some((e) => e.kind === "speak") ? "leak" : "neutral"}
        saw={
          zg.some((e) => e.kind === "speak")
            ? `fixed template text with the amount (${amt}); no name, no address. Not private mode, disclosed.`
            : "no speech requested"
        }
      />
      <Row
        who="0G Storage"
        saw={store.length || run.rootHash ? `an encrypted episode blob${run.rootHash ? ` (root ${short(run.rootHash, 8)})` : ""}` : "nothing yet"}
      />
      <Row
        who="Chain"
        tone={run.pay ? "leak" : "neutral"}
        saw={
          run.pay ? (
            <>
              agent wallet{" "}
              <a className="underline" href={ETHERSCAN_ADDR(run.pay.from)} target="_blank" rel="noreferrer noopener">
                <Mono>{short(run.pay.from)}</Mono>
              </a>{" "}
              sent {formatAmount(BigInt(run.pay.amountBase), run.intent?.decimals ?? 6)} {run.pay.symbol} + a gas drop to a fresh address{" "}
              <Mono>{short(run.pay.destination)}</Mono> (
              <a className="underline" href={ETHERSCAN_TX(run.pay.transferHash)} target="_blank" rel="noreferrer noopener">
                tx
              </a>
              ). Amount and agent wallet are public; the recipient is not linked to anyone.
            </>
          ) : (
            "no transaction"
          )
        }
      />
      <Row
        who="RPC"
        tone={run.pay ? "leak" : "neutral"}
        saw={run.pay ? `${run.pay.rpcHost}: ${run.pay.rpcCalls.join("; ")}` : run.wallet ? `${run.wallet.rpcHost}: agent wallet balance reads` : "nothing"}
      />
    </Section>
  );
}

/** Mirror of the glasses OLED (what the payer sees on the glasses). */
export function OledMirror({ lines, bridgeOpen }: { lines: readonly string[]; bridgeOpen: boolean }) {
  return (
    <div className="rounded-xl border border-neutral-700 bg-black p-3 font-mono text-sm leading-tight text-sky-200" aria-label="glasses OLED">
      {lines.map((l, i) => (
        <div key={i}>{l || " "}</div>
      ))}
      <div className="mt-2 text-[10px] text-neutral-600">{bridgeOpen ? "OLED (live)" : "OLED (bridge offline: mirror only)"}</div>
    </div>
  );
}
