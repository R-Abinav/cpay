"use client";
// One scroll container (the document), a sticky minimal header with one menu for Settings + Evidence, and a
// fixed bottom tab bar. Also owns the shared hub connection and the background recipient.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getHub } from "../lib/hub-client.js";
import { glassesLabel, useHubStatus } from "../lib/hub-hooks.js";
import { MoreIcon, PayIcon, ReceiveIcon, WalletIcon } from "./icons.js";
import { Toaster } from "./toast.js";

const TABS = [
  { href: "/", label: "Wallet", Icon: WalletIcon },
  { href: "/pay", label: "Pay", Icon: PayIcon },
  { href: "/receive", label: "Receive", Icon: ReceiveIcon },
] as const;

const TITLES: [string, string][] = [
  ["/pay", "Pay"],
  ["/receive", "Receive"],
  ["/settings", "Settings"],
  ["/evidence", "0G evidence"],
  ["/onboarding", "Set up"],
];

const isActive = (path: string | null, href: string) => (href === "/" ? path === "/" : !!path?.startsWith(href));

const TONE = { ok: "bg-emerald-400", warn: "bg-amber-400", off: "bg-neutral-600" } as const;

export function GlassesPill() {
  const s = useHubStatus();
  const l = glassesLabel(s);
  return (
    <span role="status" className="inline-flex items-center gap-2 rounded-full border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300">
      <span className={`h-2 w-2 rounded-full ${TONE[l.tone]}`} aria-hidden />
      {l.text}
    </span>
  );
}

function Menu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Settings and evidence"
        className="grid h-11 w-11 place-items-center rounded-full text-neutral-400 hover:text-neutral-100"
      >
        <MoreIcon />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 w-48 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950">
          <Link role="menuitem" href="/settings" className="flex min-h-12 items-center px-4 text-sm hover:bg-neutral-900">
            Settings
          </Link>
          <Link role="menuitem" href="/evidence" className="flex min-h-12 items-center border-t border-neutral-900 px-4 text-sm hover:bg-neutral-900">
            0G evidence
          </Link>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  useEffect(() => {
    getHub().connect();
    // Background recipient (pay protocol v2): connects only with a World ID card and when not invisible.
    // Both load after first paint so the shell stays light on every route.
    void import("../lib/recipient-service.js").then((m) => m.getRecipient().start());
    // Warm Railgun sync after unlock (private balance ready by the time the user pays).
    void import("../lib/railgun.js").then((m) => m.watchRailgun());
  }, []);
  const title = TITLES.find(([p]) => path?.startsWith(p))?.[1] ?? "CPay";
  return (
    <>
      <Toaster />
      <header
        className="sticky top-0 z-40 border-b border-neutral-900 bg-neutral-950"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between pl-4 pr-2">
          <span className="text-base font-semibold tracking-tight">{title}</span>
          <Menu />
        </div>
      </header>
      <div className="pb-[calc(5rem+env(safe-area-inset-bottom))]">{children}</div>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-900 bg-neutral-950"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="mx-auto grid max-w-xl grid-cols-3">
          {TABS.map(({ href, label, Icon }) => {
            const active = isActive(path, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? "text-emerald-400" : "text-neutral-500 hover:text-neutral-300"}`}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/** Standard page column. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={`mx-auto ${wide ? "max-w-5xl" : "max-w-xl"} space-y-8 px-4 pt-6`}>{children}</main>;
}
