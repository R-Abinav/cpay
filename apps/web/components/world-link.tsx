"use client";
// Settings: link this phone to the human's World account for Agent Pass (once). Stores only
// sha256(World sub) in the on-device vault; the server keeps nothing. Over-cap approvals must come
// from the same World account (docs/ARCHITECTURE.md onboarding step 5).
import { useEffect, useState } from "react";
import { linkWorld, linkedSubHash, openApprovalWindow } from "../lib/agent-pass-client.js";
import { VAULT, vaultDelete } from "../lib/vault.js";

export function WorldLink() {
  const [linked, setLinked] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    linkedSubHash().then(setLinked, () => setLinked(null));
  }, []);

  async function link() {
    const win = openApprovalWindow(); // inside the tap, or the browser blocks it
    setBusy(true);
    setMsg(null);
    setUrl(null);
    try {
      const r = await linkWorld(win, setUrl);
      if (r.approved && r.mode === "link") {
        setLinked(r.subHash);
        setMsg({ ok: true, text: "World linked. Over-cap payments now ask this World account." });
      } else {
        setMsg({ ok: false, text: `Not linked: ${r.approved ? "unexpected result" : r.reason}. Nothing changed.` });
      }
    } finally {
      setBusy(false);
      setUrl(null);
    }
  }

  async function unlink() {
    await vaultDelete(VAULT.worldSubHash);
    setLinked(null);
    setMsg({ ok: true, text: "Unlinked. Over-cap payments are refused until you link again." });
  }

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h2 className="text-lg font-semibold">World Agent Pass</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Over a limit, the agent stops and asks World to check you&apos;re the human behind this wallet. Only a hash of your World account
        ID is kept, on this phone. No name, no account on our side.
      </p>
      {linked === undefined ? null : linked ? (
        <div className="mt-4 space-y-3">
          <p className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-300">
            Linked · <span className="font-mono">{linked.slice(0, 8)}…</span>
          </p>
          <button onClick={unlink} className="w-full rounded-xl bg-neutral-800 px-5 py-3 font-semibold">
            Unlink World
          </button>
        </div>
      ) : (
        <button
          onClick={link}
          disabled={busy}
          className="mt-4 min-h-14 w-full rounded-xl bg-white px-5 text-lg font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Waiting for World…" : "Link World"}
        </button>
      )}
      {url && (
        <a href={url} target="_blank" rel="noreferrer noopener" className="mt-3 block text-center text-sm text-sky-300 underline">
          Window didn&apos;t open? Continue in World
        </a>
      )}
      {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
    </section>
  );
}
