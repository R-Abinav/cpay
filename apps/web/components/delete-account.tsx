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
      <h2 className="text-base font-semibold text-red-300">Delete my account</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Removes everything CPay holds about you: your World ID record on our issuer, your glasses pairing, and every key, card and face
        template on this phone.
      </p>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="mt-4 min-h-12 w-full rounded-xl border border-red-500/40 px-5 font-semibold text-red-300">
          Delete my account…
        </button>
      ) : (
        <div className="mt-4 space-y-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-300">
            <li>
              <b>Withdraw your funds first.</b> Nothing on chain is touched. Your wallet comes from your passkey, so with the passkey you could
              restore the same wallet later; delete the passkey too (Passwords / password manager) and any funds left become unreachable.
            </li>
            <li>World allows one World ID verification per app, so this World ID may not be able to get a CPay card again after this.</li>
            <li>Our servers keep no wallets, payments or names, so there is nothing else to delete. 0G evidence rows hold no user data.</li>
          </ul>
          {!wallet ? (
            <button type="button" onClick={() => unlockWallet().catch((e) => toast.error(errText(e)))} className="min-h-12 w-full rounded-xl border border-neutral-700 font-semibold">
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
                  className="mt-1 min-h-12 w-full rounded-xl border border-neutral-800 bg-transparent px-4 py-3 font-mono tracking-widest"
                />
              </label>
              <button
                type="button"
                disabled={typed.trim() !== "DELETE" || !!step}
                onClick={() => void run()}
                className="min-h-12 w-full rounded-xl bg-red-500 font-semibold text-black disabled:opacity-40"
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
