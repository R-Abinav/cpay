// Ready-to-receive mode: pure logic (no DOM, no React) so it can be unit-tested.
//   - dim timer: dims after DIM_AFTER_MS without a touch; a touch or an important recipient event undims
//   - event feed: privacy-safe lines built only from fixed event kinds (never addresses, amounts, peer ids)
//   - headline: one big status derived from the recipient status
//   - WakeLockKeeper: Screen Wake Lock with re-acquire on visibilitychange (browser objects injected)
import type { RecipientEvent, RecipientEventKind, RecipientStatus } from "./recipient-service.js";

export const DIM_AFTER_MS = 20_000;

// ------------------------------------------------------------------------------------------------ dim timer
export interface DimState {
  dimmed: boolean;
  lastActivity: number;
}
export type DimAction = { type: "activity"; at: number } | { type: "tick"; at: number } | { type: "event"; at: number; kind: RecipientEventKind };

/** Events worth waking the screen for: something happened that the recipient wants to see. */
export const WAKING_EVENTS: ReadonlySet<RecipientEventKind> = new Set(["matched", "quote_answered", "quote_failed_locked", "relay_lost"]);

export function initialDim(now: number): DimState {
  return { dimmed: false, lastActivity: now };
}

export function dimReducer(s: DimState, a: DimAction): DimState {
  switch (a.type) {
    case "activity":
      return { dimmed: false, lastActivity: a.at };
    case "event":
      return WAKING_EVENTS.has(a.kind) ? { dimmed: false, lastActivity: a.at } : s;
    case "tick": {
      const dimmed = a.at - s.lastActivity >= DIM_AFTER_MS;
      return dimmed === s.dimmed ? s : { ...s, dimmed };
    }
  }
}

/** ms until the next tick can change anything (null while already dimmed: only activity undims). */
export function msUntilDim(s: DimState, now: number): number | null {
  return s.dimmed ? null : Math.max(0, s.lastActivity + DIM_AFTER_MS - now);
}

// ------------------------------------------------------------------------------------------------ event feed
export type FeedTone = "ok" | "info" | "warn" | "muted";
export interface FeedEntry {
  at: number;
  kind: RecipientEventKind;
  /** consecutive repeats of the same kind collapsed into one line */
  count: number;
}
export interface FeedText {
  text: string;
  tone: FeedTone;
  /** optional in-app link (never external) */
  link?: { href: string; label: string };
}

const TEXT: Record<RecipientEventKind, FeedText> = {
  relay_open: { text: "Connected to the relay", tone: "muted" },
  relay_lost: { text: "Relay connection lost: reconnecting", tone: "warn" },
  probe_no_match: { text: "Face probe: not you (stayed silent)", tone: "muted" },
  matched: { text: "Matched: a payer's glasses saw you (answered, sealed)", tone: "info" },
  quote_answered: {
    text: "Payment request answered. Received? Check your private balance",
    tone: "ok",
    link: { href: "/", label: "Private balance" },
  },
  quote_refused: { text: "Payment request refused (no match, QR not shown, or wrong network)", tone: "muted" },
  quote_failed_locked: { text: "Couldn't answer a payment request: wallet locked", tone: "warn" },
  quote_failed: { text: "Couldn't answer a payment request", tone: "warn" },
};

export function describeEvent(kind: RecipientEventKind): FeedText {
  return TEXT[kind];
}

export const FEED_MAX = 40;
/** Coalesce a repeat of the newest kind (within 60 s) into a counter; newest first; bounded. */
export function pushFeed(feed: readonly FeedEntry[], e: RecipientEvent, max = FEED_MAX): FeedEntry[] {
  const head = feed[0];
  if (head && head.kind === e.kind && e.at - head.at < 60_000) return [{ at: e.at, kind: e.kind, count: head.count + 1 }, ...feed.slice(1)];
  return [{ at: e.at, kind: e.kind, count: 1 }, ...feed].slice(0, max);
}

// ------------------------------------------------------------------------------------------------ headline
export type HeadlineTone = "ready" | "working" | "blocked";
export interface Headline {
  title: string;
  detail: string;
  tone: HeadlineTone;
}
export interface HeadlineInput {
  status: Pick<RecipientStatus, "relay" | "hasCard" | "invisible" | "reconnectAt" | "detail">;
  walletUnlocked: boolean;
  relayConfigured: boolean;
  qrReady: boolean;
  now: number;
}

export function readyHeadline(i: HeadlineInput): Headline {
  const { status: s } = i;
  if (!i.relayConfigured) return { title: "Relay not connected", detail: "NEXT_PUBLIC_RELAY_URL is not set", tone: "blocked" };
  if (!s.hasCard) return { title: "Not ready: no World ID card", detail: "Verify with World ID on the Receive tab", tone: "blocked" };
  if (s.invisible) return { title: "You're invisible", detail: "Turn invisible off to get paid", tone: "blocked" };
  if (!i.walletUnlocked) return { title: "Unlock to get paid", detail: "One-time addresses are derived from your wallet on this phone", tone: "blocked" };
  if (s.relay === "open" && i.qrReady) return { title: "Ready to get paid", detail: "Keep this screen open", tone: "ready" };
  if (s.relay === "open") return { title: "Connecting…", detail: "Waiting for the relay to assign this phone a peer id", tone: "working" };
  if (s.relay === "connecting") return { title: "Connecting to the relay…", detail: "", tone: "working" };
  if (s.reconnectAt) {
    const secs = Math.max(0, Math.ceil((s.reconnectAt - i.now) / 1000));
    return { title: "Reconnecting…", detail: `Relay connection lost. Retrying in ${secs} s`, tone: "working" };
  }
  return { title: "Not connected", detail: s.detail || "Tap Reconnect", tone: "blocked" };
}

// ------------------------------------------------------------------------------------------------ wake lock
export type WakeLockState = "idle" | "active" | "unsupported" | "denied" | "released";

interface SentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", fn: () => void): void;
}
export interface WakeEnv {
  wakeLock?: { request(type: "screen"): Promise<SentinelLike> };
  isVisible(): boolean;
  onVisibility(fn: () => void): () => void;
}

/** Holds a screen wake lock while started; re-acquires when the page becomes visible again. */
export class WakeLockKeeper {
  state: WakeLockState = "idle";
  detail = "";
  private sentinel: SentinelLike | null = null;
  private off: (() => void) | null = null;
  private running = false;

  constructor(
    private readonly env: WakeEnv,
    private readonly onChange: (s: WakeLockState, detail: string) => void = () => undefined,
  ) {}

  private setState(s: WakeLockState, detail = ""): void {
    this.state = s;
    this.detail = detail;
    this.onChange(s, detail);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (!this.env.wakeLock) return this.setState("unsupported");
    this.off = this.env.onVisibility(() => {
      if (this.running && this.env.isVisible() && (!this.sentinel || this.sentinel.released)) void this.acquire();
    });
    await this.acquire();
  }

  private async acquire(): Promise<void> {
    if (!this.env.wakeLock || !this.env.isVisible()) return;
    try {
      const s = await this.env.wakeLock.request("screen");
      if (!this.running) {
        await s.release().catch(() => undefined);
        return;
      }
      this.sentinel = s;
      s.addEventListener?.("release", () => {
        if (this.sentinel === s) {
          this.sentinel = null;
          if (this.running) this.setState("released", "the system released the lock; it comes back when you return");
        }
      });
      this.setState("active");
    } catch (e) {
      this.setState("denied", e instanceof Error ? e.message : String(e));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.off?.();
    this.off = null;
    const s = this.sentinel;
    this.sentinel = null;
    if (s && !s.released) await s.release().catch(() => undefined);
    if (this.state !== "unsupported") this.setState("idle");
  }
}
