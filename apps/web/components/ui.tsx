"use client";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { toast } from "../lib/toast.js";
import { DEPENDENCY_LABEL, type DependencyId, type DependencyState } from "../lib/deps.js";

/** A page section: hairline above, quiet heading, no filled card. */
export function Section({ title, step, children, done, bare }: { title: string; step?: number; children: ReactNode; done?: boolean; bare?: boolean }) {
  // bare: inside a screen that already has its own heading (the onboarding wizard).
  if (bare) return <section>{children}</section>;
  return (
    <section className="border-t border-neutral-900 pt-6">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        {step !== undefined && (
          <span
            className={`grid h-6 w-6 place-items-center rounded-full text-xs ${done ? "bg-emerald-500 text-black" : "border border-neutral-700 text-neutral-400"}`}
            aria-hidden
          >
            {done ? "✓" : step}
          </span>
        )}
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Collapsed "Details" disclosure for logs, evidence and power-user controls. */
export function Details({ summary = "Details", children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="group border-t border-neutral-900 pt-2">
      <summary className="flex min-h-12 cursor-pointer select-none items-center justify-between text-sm text-neutral-400 hover:text-neutral-200">
        {summary}
        <span className="text-neutral-600 transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
      </summary>
      <div className="space-y-6 pb-4 pt-2">{children}</div>
    </details>
  );
}

type Tone = "primary" | "secondary" | "danger";
const TONE: Record<Tone, string> = {
  primary: "bg-emerald-500 text-black hover:bg-emerald-400",
  secondary: "border border-neutral-800 text-neutral-100 hover:bg-neutral-900",
  danger: "border border-red-500/40 text-red-300 hover:bg-red-500/10",
};

/** Large touch target (min 48px). */
export function Button({ tone = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      {...p}
      className={`min-h-12 rounded-xl px-5 py-3 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONE[tone]} ${className}`}
    />
  );
}

const STATE_STYLE: Record<DependencyState, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  not_connected: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  offline: "bg-red-500/15 text-red-300 border-red-500/40",
  unknown: "bg-neutral-700/40 text-neutral-300 border-neutral-600",
};
const STATE_TEXT: Record<DependencyState, string> = { ok: "connected", not_connected: "not connected", offline: "offline", unknown: "…" };

export function DepPill({ id, state, detail }: { id: DependencyId; state: DependencyState; detail?: string }) {
  return (
    <span title={detail} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${STATE_STYLE[state]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {DEPENDENCY_LABEL[id]}: {STATE_TEXT[state]}
    </span>
  );
}

/** The visible "not connected" state for an unwired/unconfigured dependency. Never a fake success. */
export function NotConnected({ id, detail }: { id: DependencyId; detail: string }) {
  return (
    <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
      <strong className="block">{DEPENDENCY_LABEL[id]}: not connected</strong>
      <span className="break-words text-amber-200/80">{detail}</span>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200 break-words">{children}</div>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="break-all font-mono text-xs text-neutral-300">{children}</code>;
}

export const short = (s: string, n = 6) => (s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);

/** Small copy-to-clipboard icon button. Copies on this device only (no network). */
export function CopyButton({ value, label = "address", className = "" }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true);
            toast.info(`Copied ${label}`);
            setTimeout(() => setDone(false), 1500);
          },
          () => toast.error("Couldn't copy"),
        );
      }}
      className={`inline-grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-neutral-800 text-neutral-400 transition-colors hover:text-neutral-100 active:scale-95 ${className}`}
    >
      {done ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

/** An address shown short (or in full) with a copy button next to it. */
export function Address({ value, full = false, label = "address", className = "" }: { value: string; full?: boolean; label?: string; className?: string }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-2 align-middle ${className}`}>
      <span className={`font-mono ${full ? "break-all" : ""}`}>{full ? value : short(value)}</span>
      <CopyButton value={value} label={label} />
    </span>
  );
}
