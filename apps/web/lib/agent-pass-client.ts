"use client";
// Browser side of World Agent Pass (docs/ARCHITECTURE.md onboarding step 5 + POLICY).
//   link:    Settings -> World -> sha256(sub) kept in the on-device vault (never on a server).
//   approve: over-cap payment -> World -> Ed25519 approval token -> the caller verifies it with
//            lib/wallet.ts verifyApproval() before anything is signed. Only the salted bindingCommit
//            (lib/wallet.ts approvalCommit) is sent; the payment and its salt never leave this phone.
// The World page opens in a new window (it must be opened inside a tap: browsers block popups otherwise);
// this tab polls POST /api/agent-pass/status until the attempt finishes, is cancelled, or expires.
import { AgentPassStartResponse, AgentPassStatus, readApi } from "./api.js";
import { VAULT, vaultGet, vaultSet } from "./vault.js";

export type AgentPassOutcome =
  | { approved: true; mode: "link"; subHash: string }
  | { approved: true; mode: "approve"; subHash: string; token: string }
  | { approved: false; reason: string };

export async function linkedSubHash(): Promise<string | null> {
  return vaultGet<string>(VAULT.worldSubHash);
}

/** Open a blank window synchronously inside the user's tap; the World URL is set once we have it. */
export function openApprovalWindow(): Window | null {
  try {
    return window.open("about:blank", "cpay-agent-pass");
  } catch {
    return null;
  }
}

const POLL_MS = 1500;
/** A little longer than the server's attempt TTL (AGENT_PASS_APPROVAL_TTL_SECONDS, default 300). */
const GIVE_UP_MS = 330_000;

/**
 * Run one Agent Pass attempt. Resolves with the outcome; never throws for a denial. `onUrl` gets the World
 * URL (shown as a fallback link if the window was blocked). Aborting cancels the attempt server-side.
 */
export async function runAgentPass(
  req: { mode: "link" } | { mode: "approve"; bindingCommit: string; subHash: string },
  opts: { win: Window | null; signal?: AbortSignal; onUrl?: (url: string) => void },
): Promise<AgentPassOutcome> {
  const started = await readApi(
    fetch("/api/agent-pass/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: opts.signal,
    }),
    AgentPassStartResponse,
  );
  if (!started.ok) {
    opts.win?.close();
    return { approved: false, reason: started.message };
  }
  const { url, attempt } = started;
  if (opts.win && !opts.win.closed) opts.win.location.href = url;
  opts.onUrl?.(url);

  // The attempt id goes in a POST body, never the query string (access logs record URLs).
  const status = (action: "poll" | "cancel") =>
    fetch("/api/agent-pass/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attempt, action }),
      cache: "no-store",
    });
  const cancel = () => void status("cancel").catch(() => undefined);

  // Wake up early when the callback page posts back (same origin only).
  let wake: (() => void) | null = null;
  const onMsg = (e: MessageEvent) => {
    if (e.origin === location.origin && (e.data as { type?: unknown })?.type === "cpay-agent-pass") wake?.();
  };
  window.addEventListener("message", onMsg);
  const deadline = Date.now() + GIVE_UP_MS;
  try {
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        cancel();
        return { approved: false, reason: "cancelled" };
      }
      const s = await readApi(status("poll"), AgentPassStatus);
      if (s.ok && s.state === "done") {
        if (!s.approved) return { approved: false, reason: s.reason ?? "not approved" };
        if (s.mode === "link" && s.subHash) return { approved: true, mode: "link", subHash: s.subHash };
        if (s.mode === "approve" && s.subHash && s.token) return { approved: true, mode: "approve", subHash: s.subHash, token: s.token };
        return { approved: false, reason: "unexpected Agent Pass result" };
      }
      if (s.ok && s.state === "none") return { approved: false, reason: "attempt expired" };
      await new Promise<void>((r) => {
        const t = setTimeout(r, POLL_MS);
        wake = () => {
          clearTimeout(t);
          r();
        };
        opts.signal?.addEventListener("abort", () => wake?.(), { once: true });
      });
      wake = null;
    }
    cancel();
    return { approved: false, reason: "attempt expired" };
  } finally {
    window.removeEventListener("message", onMsg);
  }
}

/** Settings: link this phone to the human's World account (once). Stores only sha256(sub), on this phone. */
export async function linkWorld(win: Window | null, onUrl?: (url: string) => void): Promise<AgentPassOutcome> {
  const r = await runAgentPass({ mode: "link" }, { win, onUrl });
  if (r.approved && r.mode === "link") await vaultSet(VAULT.worldSubHash, r.subHash);
  return r;
}
