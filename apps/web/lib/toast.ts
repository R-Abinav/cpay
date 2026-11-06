// Tiny toast store (no deps). Toasts are the app's only transient feedback: on /pay they appear exactly when
// the matching voice reply starts playing. At most MAX_VISIBLE at once (newest wins); info toasts expire,
// error toasts stay until tapped. Never put a confirm code, transcript or full address in a toast.

export type ToastKind = "info" | "success" | "warn" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  link?: { href: string; label: string };
}

export const TOAST_LIMITS = { maxVisible: 2, infoMs: 3_000 } as const;

type Timer = ReturnType<typeof setTimeout>;

export class ToastStore {
  private list: readonly Toast[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<number, Timer>();
  private nextId = 1;

  constructor(
    private readonly setT: (fn: () => void, ms: number) => Timer = setTimeout,
    private readonly clearT: (t: Timer) => void = clearTimeout,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): readonly Toast[] => this.list;

  /** Show a toast. The same text already on screen is refreshed instead of stacked. Returns its id. */
  show(kind: ToastKind, raw: string, link?: Toast["link"]): number {
    const text = toastSafe(raw);
    const same = this.list.find((t) => t.text === text && t.kind === kind);
    if (same) this.drop(same.id, false);
    const t: Toast = { id: this.nextId++, kind, text, ...(link ? { link } : {}) };
    let next = [...this.list, t];
    while (next.length > TOAST_LIMITS.maxVisible) {
      const old = next[0]!;
      this.clearTimer(old.id);
      next = next.slice(1);
    }
    this.list = next;
    if (kind !== "error") this.timers.set(t.id, this.setT(() => this.dismiss(t.id), TOAST_LIMITS.infoMs));
    this.emit();
    return t.id;
  }

  info = (text: string, link?: Toast["link"]) => this.show("info", text, link);
  success = (text: string, link?: Toast["link"]) => this.show("success", text, link);
  warn = (text: string, link?: Toast["link"]) => this.show("warn", text, link);
  error = (text: string, link?: Toast["link"]) => this.show("error", text, link);

  dismiss(id: number): void {
    this.drop(id, true);
  }

  clear(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    this.list = [];
    this.emit();
  }

  private drop(id: number, emit: boolean): void {
    this.clearTimer(id);
    const next = this.list.filter((t) => t.id !== id);
    if (next.length === this.list.length) return;
    this.list = next;
    if (emit) this.emit();
  }
  private clearTimer(id: number): void {
    const t = this.timers.get(id);
    if (t !== undefined) this.clearT(t);
    this.timers.delete(id);
  }
  private emit(): void {
    this.listeners.forEach((f) => f());
  }
}

/** The app-wide store (one per tab). */
export const toast = new ToastStore();

/** Error text for a toast from anything thrown: viem's short message when there is one (its full message lists
 *  addresses and calldata under "Request Arguments"). The full text belongs in the collapsed log only. */
export const errText = (e: unknown): string => {
  if (e instanceof Error) {
    const short = (e as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" && short ? short : e.message;
  }
  return String(e);
};

export const TOAST_MAX_CHARS = 120;

/** Every toast passes through here: cut viem/RPC detail sections, shorten addresses and long hex, cap length.
 *  Toasts are big and on screen in public, so no full address or calldata ever reaches one. */
export function toastSafe(text: string): string {
  let t = text.split(/\s*(?:Request Arguments:|Raw Call Arguments:|Contract Call:|Details:|Docs:|URL:|Version:)/)[0]!;
  t = t.replace(/0x[0-9a-fA-F]{40,}/g, (h) => `${h.slice(0, 6)}…${h.slice(-4)}`);
  t = t.replace(/\s+/g, " ").trim();
  return t.length > TOAST_MAX_CHARS ? `${t.slice(0, TOAST_MAX_CHARS - 1)}…` : t;
}
