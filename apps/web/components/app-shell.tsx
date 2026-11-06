"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { getHub } from "../lib/hub-client.js";
import { getRecipient } from "../lib/recipient-service.js";
import { glassesLabel, useHubStatus } from "../lib/hooks.js";
import { Toaster } from "./toast.js";

const TABS = [
  { href: "/", label: "Wallet", icon: "◎" },
  { href: "/pay", label: "Pay", icon: "➤" },
  { href: "/receive", label: "Receive", icon: "▣" },
  { href: "/activity", label: "Activity", icon: "≡" },
  { href: "/settings", label: "Settings", icon: "⚙" },
] as const;

const TONE = { ok: "bg-emerald-400", warn: "bg-amber-400", off: "bg-neutral-500" } as const;

export function GlassesPill() {
  const s = useHubStatus();
  const l = glassesLabel(s);
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-200">
      <span className={`h-2 w-2 rounded-full ${TONE[l.tone]}`} aria-hidden />
      {l.text}
    </span>
  );
}

/** Bottom tab nav + one shared hub connection (reconnects every 2 s while paired). */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  useEffect(() => {
    getHub().connect();
    // Background recipient (pay protocol v2): connects only with a World ID card and when not invisible.
    void getRecipient().start();
  }, []);
  return (
    <>
      <Toaster />
      <div className="pb-24">{children}</div>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-800 bg-neutral-950/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="mx-auto grid max-w-xl grid-cols-5">
          {TABS.map((t) => {
            const active = t.href === "/" ? path === "/" : path?.startsWith(t.href);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className={`flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs ${active ? "text-emerald-400" : "text-neutral-400"}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="text-xl leading-none" aria-hidden>
                    {t.icon}
                  </span>
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
