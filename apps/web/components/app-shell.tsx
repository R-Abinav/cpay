"use client";
// One scroll container (the document), a sticky minimal header with one menu for Settings + Evidence, and a
// fixed bottom tab bar. Also owns the shared hub connection and the background recipient.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getHub, glassesState } from "../lib/hub-client.js";
import { glassesLabel, useHubStatus } from "../lib/hub-hooks.js";
import { MoreIcon, PayIcon, ReceiveIcon, WalletIcon } from "./icons.js";
import { Particles } from "./particles.js";
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

/** Header pill: green "Glasses paired" when paired + online, grey when offline, a "Pair glasses" link when unpaired. */
function HeaderGlasses() {
  const s = useHubStatus();
  const g = glassesState(s);
  if (g === "unpaired" || g === "restarted")
    return (
      <Link
        href="/settings"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-emerald-500/40 px-3 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10"
      >
        Pair glasses
      </Link>
    );
  const ok = g === "paired";
  const text = ok ? "Glasses paired" : g === "connecting" ? "Connecting…" : g === "no_hub" ? "No glasses hub" : "Glasses offline";
  return (
    <span
      role="status"
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs ${ok ? "border-emerald-500/30 text-emerald-300" : "border-neutral-800 text-neutral-400"}`}
    >
      <span className={`h-2 w-2 rounded-full ${ok ? "cpay-dot-live bg-emerald-400" : "bg-neutral-600"}`} aria-hidden />
      {text}
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
  const router = useRouter();
  // "/" decides first: no wallet on this phone -> straight to the landing page, without flashing the wallet/unlock screen.
  const [gate, setGate] = useState<"checking" | "open">(path === "/" ? "checking" : "open");
  useEffect(() => {
    if (gate !== "checking") return;
    let live = true;
    void import("../lib/wallet.js")
      .then((m) => m.hasWallet())
      .catch(() => true) // can't tell: show the wallet page, which reports the error
      .then((has) => {
        if (!live) return;
        if (has) setGate("open");
        else router.replace("/welcome");
      });
    return () => {
      live = false;
    };
  }, [gate, router]);
  useEffect(() => {
    if (path !== "/") setGate("open");
  }, [path]);
  useEffect(() => {
    getHub().connect();
    // Background recipient (pay protocol v2): connects only with a World ID card and when not invisible.
    // Both load after first paint so the shell stays light on every route.
    void import("../lib/recipient-service.js").then((m) => m.getRecipient().start());
    // Warm Railgun sync after unlock (private balance ready by the time the user pays).
    void import("../lib/railgun.js").then((m) => m.watchRailgun());
    // Warm the self-hosted face model (onnxruntime + YuNet + SFace) right after first paint, so face capture
    // and face scans start instantly. Same-origin files only; no camera involved. A failure is retried on use.
    const warmFace = () => void import("../lib/face/engine.js").then((m) => m.loadFaceEngine()).catch(() => undefined);
    if ("requestIdleCallback" in window) window.requestIdleCallback(warmFace, { timeout: 1500 });
    else setTimeout(warmFace, 300);
  }, []);
  const title = TITLES.find(([p]) => path?.startsWith(p))?.[1] ?? "CPay";
  if (gate === "checking" && path === "/") {
    return (
      <div className="relative h-dvh overflow-hidden" aria-busy aria-label="Loading">
        <Particles />
      </div>
    );
  }
  // The landing page and the onboarding wizard are full-screen and exactly one viewport tall: no header, no tab bar, no page scroll.
  if (path === "/welcome" || path?.startsWith("/onboarding")) {
    return (
      <>
        <Toaster />
        <div
          className="flex h-dvh w-full flex-col overflow-hidden"
          style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {children}
        </div>
      </>
    );
  }
  return (
    <>
      <Toaster />
      <header
        className="sticky top-0 z-40 border-b border-neutral-900 bg-neutral-950"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between pl-4 pr-2">
          <span className="text-base font-semibold tracking-tight">{title}</span>
          <div className="flex items-center gap-1">
            <HeaderGlasses />
            <Menu />
          </div>
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
