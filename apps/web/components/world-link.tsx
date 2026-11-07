"use client";
// Settings: link this phone to the human's World account for Agent Pass (once). Stores only
// sha256(World sub) in the on-device vault; the server keeps nothing. Over-cap approvals must come
// from the same World account (docs/ARCHITECTURE.md onboarding step 5).
import { useEffect, useState } from "react";
import { linkWorld, linkedSubHash, openApprovalWindow } from "../lib/agent-pass-client.js";
import { errText, toast } from "../lib/toast.js";
import { VAULT, vaultDelete } from "../lib/vault.js";

export function WorldLink() {
  const [linked, setLinked] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    linkedSubHash().then(setLinked, () => setLinked(null));
  }, []);

  async function link() {
    const win = openApprovalWindow(); // inside the tap, or the browser blocks it
    setBusy(true);
    setUrl(null);
    try {
      const r = await linkWorld(win, setUrl);
      if (r.approved && r.mode === "link") {
        setLinked(r.subHash);
        toast.success("World linked. Over-cap payments now ask this World account.");
      } else {
        toast.error(`Not linked: ${r.approved ? "unexpected result" : r.reason}. Nothing changed.`);
      }
    } catch (e) {
      toast.error(`Not linked: ${errText(e)}. Nothing changed.`);
    } finally {
      setBusy(false);
      setUrl(null);
    }
  }

  async function unlink() {
    await vaultDelete(VAULT.worldSubHash);
    setLinked(null);
    toast.info("Unlinked. Over-cap payments are refused until you link again.");
  }

  return (
    <section className="border-t border-neutral-900 pt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">World Agent Pass</h2>
        {linked && <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">Linked</span>}
      </div>
      <p className="mt-1 text-sm text-neutral-400">Over a limit, World checks it&apos;s really you. Only a hash stays on this phone.</p>
      {linked === undefined ? null : linked ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-3">
          <span className="min-w-0 text-sm text-neutral-300">
            World account <span className="font-mono text-neutral-500">{linked.slice(0, 8)}…</span>
          </span>
          <button
            type="button"
            onClick={() => {
              if (confirm("Unlink World? Over-cap payments will be refused until you link again.")) void unlink();
            }}
            className="min-h-11 shrink-0 rounded-xl border border-neutral-800 px-4 text-sm font-semibold text-neutral-300 hover:bg-neutral-900"
          >
            Unlink
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={link}
          disabled={busy}
          className="mt-4 min-h-14 w-full rounded-2xl bg-white px-5 text-lg font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Waiting for World…" : "Link World"}
        </button>
      )}
      {url && (
        <a href={url} target="_blank" rel="noreferrer noopener" className="mt-3 block min-h-11 py-2 text-center text-sm text-neutral-400 underline">
          Window didn&apos;t open? Continue in World
        </a>
      )}
    </section>
  );
}
