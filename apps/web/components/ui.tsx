"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { DEPENDENCY_LABEL, type DependencyId, type DependencyState } from "../lib/deps.js";

export function Section({ title, step, children, done }: { title: string; step?: number; children: ReactNode; done?: boolean }) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        {step !== undefined && (
          <span
            className={`grid h-7 w-7 place-items-center rounded-full text-sm ${done ? "bg-emerald-500 text-black" : "bg-neutral-700"}`}
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

type Tone = "primary" | "secondary" | "danger";
const TONE: Record<Tone, string> = {
  primary: "bg-emerald-500 text-black hover:bg-emerald-400",
  secondary: "bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

/** Large touch target (min 48px). */
export function Button({ tone = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      {...p}
      className={`min-h-12 rounded-xl px-5 py-3 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${TONE[tone]} ${className}`}
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
