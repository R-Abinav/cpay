"use client";
// Wallet tab: "Your setup", one row per piece (passkey wallet, World ID, face pay, glasses, funds, Agent Pass) with a
// tick or the one action that finishes it. Everything is read on this phone (vault, hub status, the balance the page
// already has); nothing is sent anywhere. World ID and face enrolment open in a sheet so nobody has to hunt for them.
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Card } from "@cpay/credential";
import { CredentialStep } from "../app/receive/credential-step.js";
import { FaceEnrol, useStoredTemplate } from "./face-enrol.js";
import { glassesState } from "../lib/hub-client.js";
import { useHubStatus } from "../lib/hooks.js";
import { getRecipient } from "../lib/recipient-service.js";
import { VAULT, vaultGet } from "../lib/vault.js";

type Sheet = "world" | "face" | null;

interface Item {
  id: string;
  label: string;
  done: boolean | null; // null: still loading
  optional?: boolean;
  sub?: string;
  action?: ReactNode;
}

const ACTION = "inline-flex min-h-9 shrink-0 items-center rounded-full border border-neutral-700 px-3.5 text-sm font-medium text-neutral-100 hover:bg-neutral-900";
const QUIET = "inline-flex min-h-9 shrink-0 items-center px-2 text-xs text-neutral-500 hover:text-neutral-300";

export function SetupChecklist({ funded }: { funded: boolean | null }) {
  const [card, setCard] = useState<Card | null | undefined>(undefined);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [template, setTemplate] = useStoredTemplate();
  const hub = useHubStatus();
  const [sheet, setSheet] = useState<Sheet>(null);

  const load = useCallback(() => {
    vaultGet<Card>(VAULT.card).then(setCard, () => setCard(null));
    vaultGet<string>(VAULT.worldSubHash).then((v) => setLinked(!!v), () => setLinked(false));
  }, []);
  useEffect(load, [load]);

  const g = glassesState(hub);
  const paired = g === "paired" || g === "offline" || g === "connecting";

  const items: Item[] = [
    { id: "wallet", label: "Wallet", sub: "Passkey on this phone", done: true },
    {
      id: "world",
      label: "World ID verified",
      done: card === undefined ? null : !!card,
      action: (
        <button className={ACTION} onClick={() => setSheet("world")}>
          Verify
        </button>
      ),
    },
    {
      id: "face",
      label: "Face pay",
      done: template === undefined ? null : !!template,
      action: (
        <button className={ACTION} onClick={() => setSheet("face")}>
          Enrol
        </button>
      ),
      sub: template ? undefined : "Stays on this phone",
    },
    {
      id: "glasses",
      label: "Glasses paired",
      done: g === "no_hub" ? false : paired,
      sub: g === "offline" ? "Offline right now" : g === "connecting" ? "Connecting…" : g === "restarted" ? "Restarted · enter the new code" : undefined,
      action:
        g === "no_hub" ? (
          <span className="text-xs text-neutral-500">Not connected</span>
        ) : (
          <Link href="/settings" className={ACTION}>
            Pair
          </Link>
        ),
    },
    {
      id: "funded",
      label: "Funded",
      done: funded,
      action: (
        <a href="#topup" className={ACTION}>
          Top up
        </a>
      ),
    },
    {
      id: "agentpass",
      label: "Agent Pass linked",
      optional: true,
      done: linked,
      sub: "For payments over your limit",
      action: (
        <Link href="/settings" className={ACTION}>
          Link
        </Link>
      ),
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const required = items.filter((i) => !i.optional);
  const allSet = required.every((i) => i.done);
  const loading = items.some((i) => i.done === null);

  const list = (
    <ul className="divide-y divide-neutral-900">
      {items.map((i) => (
        <li key={i.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
          <Tick done={i.done} />
          <span className="min-w-0 flex-1">
            <span className={`block text-[15px] ${i.done ? "text-neutral-300" : "text-neutral-100"}`}>
              {i.label}
              {i.optional && !i.done && <span className="ml-1.5 text-xs text-neutral-500">optional</span>}
            </span>
            {i.sub && <span className="block text-xs text-neutral-500">{i.sub}</span>}
          </span>
          {i.done === false && i.action}
          {i.id === "face" && i.done && (
            <button className={QUIET} onClick={() => setSheet("face")}>
              Re-enrol
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-label="Your setup">
      {allSet && !loading ? (
        <details className="group rounded-2xl border border-neutral-800">
          <summary className="flex min-h-14 cursor-pointer select-none list-none items-center gap-3 px-4 [&::-webkit-details-marker]:hidden">
            <Tick done />
            <span className="flex-1 text-[15px] font-medium">All set</span>
            <span className="text-xs tabular-nums text-neutral-500">
              {doneCount} of {items.length}
            </span>
            <span className="text-neutral-600 transition-transform group-open:rotate-90" aria-hidden>
              ›
            </span>
          </summary>
          <div className="border-t border-neutral-900">{list}</div>
        </details>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-800">
          <div className="flex items-center gap-3 px-4 pb-3 pt-4">
            <h2 className="flex-1 text-[15px] font-semibold">Your setup</h2>
            <span className="text-xs tabular-nums text-neutral-500">
              {doneCount} of {items.length}
            </span>
          </div>
          <div className="mx-4 mb-1 h-1 overflow-hidden rounded-full bg-neutral-900" aria-hidden>
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(doneCount / items.length) * 100}%` }} />
          </div>
          {list}
        </div>
      )}

      {sheet && (
        <BottomSheet
          title={sheet === "world" ? "Verify with World ID" : "Face pay"}
          onClose={() => {
            setSheet(null);
            load();
          }}
        >
          {sheet === "world" ? (
            <CredentialStep
              card={card ?? null}
              onCard={(c) => {
                setCard(c);
                void getRecipient().start();
                setSheet(null);
              }}
              enabled
              bare
            />
          ) : template !== undefined ? (
            <FaceEnrol template={template} onTemplate={(t) => void setTemplate(t)} bare />
          ) : null}
        </BottomSheet>
      )}
    </section>
  );
}

function Tick({ done }: { done: boolean | null }) {
  if (done)
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/50" aria-label="done">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  return (
    <span
      className={`h-6 w-6 shrink-0 rounded-full border ${done === null ? "animate-pulse border-neutral-800" : "border-neutral-700"}`}
      aria-label={done === null ? "checking" : "to do"}
    />
  );
}

function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="cpay-rise mx-auto flex max-h-[92dvh] w-full max-w-xl flex-col rounded-t-3xl border-t border-neutral-800 bg-neutral-950"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="min-h-11 px-2 text-sm text-neutral-400">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">{children}</div>
      </div>
    </div>
  );
}
