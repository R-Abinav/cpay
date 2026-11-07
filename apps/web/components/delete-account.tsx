"use client";
// Settings -> "Delete my account": deboard completely. Deletes our issuer row and pairing, then wipes this phone.
import { useState } from "react";
import { deleteAccount } from "../lib/delete-account.js";
import { useWallet } from "../lib/hooks.js";
import { errText, toast } from "../lib/toast.js";
import { unlockWallet } from "../lib/wallet.js";

export function DeleteAccount() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [step, setStep] = useState<string | null>(null);

  async function run() {
    try {
      const r = await deleteAccount(setStep);
      setStep("Done. Everything is gone.");
      toast.success(
        `Account deleted${r.issuerRows === "skipped" ? "" : ` · issuer rows removed: ${r.issuerRows}`}${r.glasses === "unpaired" ? " · glasses unpaired" : ""}`,
      );
      setTimeout(() => location.replace("/welcome"), 1200);
    } catch (e) {
      setStep(null);
      toast.error(`Nothing was deleted on this phone: ${errText(e)}`);
    }
  }

  return (
    <section className="border-t border-neutral-900 pt-6">
      <h2 className="text-base font-semibold">Delete my account</h2>
      <p className="mt-1 text-sm text-neutral-400">Removes your World ID record, glasses pairing and everything on this phone.</p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 min-h-12 w-full rounded-2xl border border-red-500/40 px-5 font-semibold text-red-300 hover:bg-red-500/10"
        >
          Delete my account…
        </button>
      ) : (
        <div className="mt-4 space-y-4 rounded-3xl border border-red-500/30 bg-red-500/5 p-4">
          <ul className="space-y-2 text-sm text-neutral-300">
            <li className="flex gap-2.5">
              <span aria-hidden className="mt-[0.5em] h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
              <span>
                <b className="text-red-200">Withdraw your funds first.</b> Your passkey can restore this wallet later; delete the passkey too and
                any funds left are gone for good.
              </span>
            </li>
            <li className="flex gap-2.5">
              <span aria-hidden className="mt-[0.5em] h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
              <span>This World ID may not be able to get a CPay card again (one verification per app).</span>
            </li>
            <li className="flex gap-2.5">
              <span aria-hidden className="mt-[0.5em] h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-600" />
              <span className="text-neutral-400">Our servers keep no wallets, payments or names, so nothing else needs deleting.</span>
            </li>
          </ul>
          {!wallet ? (
            <button type="button" onClick={() => unlockWallet().catch((e) => toast.error(errText(e)))} className="min-h-12 w-full rounded-2xl border border-neutral-700 font-semibold">
              Unlock with passkey to continue
            </button>
          ) : (
            <>
              <label className="block text-sm text-neutral-300">
                Type <b>DELETE</b> to confirm
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1.5 min-h-12 w-full rounded-2xl border border-neutral-800 bg-transparent px-4 py-3 font-mono tracking-widest"
                />
              </label>
              <button
                type="button"
                disabled={typed.trim() !== "DELETE" || !!step}
                onClick={() => void run()}
                className="min-h-12 w-full rounded-2xl bg-red-500 font-semibold text-black disabled:opacity-40"
              >
                {step ?? "Delete everything"}
              </button>
            </>
          )}
          <button type="button" disabled={!!step} onClick={() => (setOpen(false), setTyped(""))} className="min-h-11 w-full text-sm text-neutral-400">
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
