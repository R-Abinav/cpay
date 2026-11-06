"use client";
// Top-of-screen toasts. Info/success are polite and expire; warn/error are assertive and stay until tapped.
import { useSyncExternalStore } from "react";
import { toast, type Toast, type ToastKind } from "../lib/toast.js";

const EMPTY: readonly Toast[] = [];

const TONE: Record<ToastKind, string> = {
  info: "border-neutral-700 text-neutral-100",
  success: "border-emerald-500/60 text-emerald-200",
  warn: "border-amber-500/60 text-amber-200",
  error: "border-red-500/60 text-red-200",
};

function Item({ t }: { t: Toast }) {
  return (
    <li className="cpay-toast pointer-events-auto flex items-stretch overflow-hidden rounded-xl border bg-neutral-950">
      <button
        type="button"
        onClick={() => toast.dismiss(t.id)}
        className={`min-h-12 flex-1 px-4 py-3 text-left text-base leading-snug ${TONE[t.kind]}`}
        aria-label={`${t.text}. Tap to dismiss.`}
      >
        {t.text}
      </button>
      {t.link && (
        <a
          href={t.link.href}
          target="_blank"
          rel="noreferrer noopener"
          className="flex min-w-12 items-center border-l border-neutral-800 px-4 text-sm text-emerald-300 underline"
        >
          {t.link.label}
        </a>
      )}
    </li>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(toast.subscribe, toast.getSnapshot, () => EMPTY);
  const calm = list.filter((t) => t.kind === "info" || t.kind === "success");
  const loud = list.filter((t) => t.kind === "warn" || t.kind === "error");
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] mx-auto max-w-xl px-3"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
    >
      <ul role="alert" aria-live="assertive" className="space-y-2">
        {loud.map((t) => (
          <Item key={t.id} t={t} />
        ))}
      </ul>
      <ul role="status" aria-live="polite" className={`space-y-2 ${loud.length ? "mt-2" : ""}`}>
        {calm.map((t) => (
          <Item key={t.id} t={t} />
        ))}
      </ul>
    </div>
  );
}
