"use client";
import { useEffect, useState } from "react";
import { PairingCode } from "@cpay/glasses-kit/hub";
import { GlassesPill, Page } from "../../components/app-shell.js";
import { FaceEnrol, useStoredTemplate } from "../../components/face-enrol.js";
import { WorldLink } from "../../components/world-link.js";
import { cleanPairCode, getHub, glassesState, GLASSES_TEXT } from "../../lib/hub-client.js";
import { useHubStatus } from "../../lib/hooks.js";
import { errText, toast } from "../../lib/toast.js";
import { loadSettings, saveSettings, type WalletSettings } from "../../lib/wallet.js";


export default function SettingsPage() {
  return (
    <Page>
      <Glasses />
      <Caps />
      <WorldLink />
      <Face />
    </Page>
  );
}

/** Re-enrol the face template ("Re-enrol face" deletes it, then capture again). Built and kept on this phone only. */
function Face() {
  const [template, setTemplate] = useStoredTemplate();
  if (template === undefined) return null;
  return <FaceEnrol template={template} onTemplate={(t) => void setTemplate(t)} title="Face pay" />;
}

function Glasses() {
  const hub = useHubStatus();
  const state = glassesState(hub);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = PairingCode.safeParse(code).success;
  const needsCode = state === "unpaired" || state === "restarted";

  async function pair() {
    setBusy(true);
    try {
      await getHub().pair(code);
      toast.success("Paired. The glasses are linked to this phone only.");
      setCode("");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Glasses</h2>
        <GlassesPill />
      </div>
      <p role="status" className={`mt-2 text-sm ${state === "restarted" ? "text-amber-300" : state === "paired" ? "text-emerald-300" : "text-neutral-300"}`}>
        {GLASSES_TEXT[state]}
        {state === "offline" && <span className="text-neutral-500"> · power them on; they reconnect by themselves</span>}
        {state === "no_hub" && <span className="text-neutral-500"> · NEXT_PUBLIC_HUB_URL is not set in this build</span>}
      </p>
      {needsCode ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void pair();
          }}
        >
          <label className="block text-sm text-neutral-400" htmlFor="code">
            6-character code on the glasses
          </label>
          <input
            id="code"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={6}
            value={code}
            onChange={(e) => setCode(cleanPairCode(e.target.value))}
            className="w-full rounded-xl border border-neutral-800 bg-transparent px-4 py-4 text-center font-mono text-3xl tracking-[0.3em]"
            placeholder="ABC234"
          />
          <button
            type="submit"
            disabled={!valid || busy}
            className="min-h-14 w-full rounded-xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
          >
            {busy ? "Pairing…" : "Pair glasses"}
          </button>
        </form>
      ) : state === "paired" || state === "offline" ? (
        <div className="mt-3 space-y-3">
          <button
            className="min-h-12 w-full rounded-xl border border-red-500/40 px-5 font-semibold text-red-300 hover:bg-red-500/10"
            onClick={() => {
              if (confirm("Unpair these glasses? They will show a new pairing code.")) getHub().unpair();
            }}
          >
            Unpair glasses
          </button>
        </div>
      ) : null}
      {hub.lastError && <p className="mt-3 text-sm text-red-300">{hub.lastError}</p>}
      <p className="mt-4 text-xs text-neutral-500">
        Every power-on of the glasses shows a new code. The hub stores only a hash of a random token made on this phone. It forwards camera
        frames to this phone while you scan and keeps nothing (not end-to-end encrypted yet).
      </p>
    </section>
  );
}

/** Spend caps, edited generically from @cpay/wallet's settings object (stored on this phone only). */
function Caps() {
  const [s, setS] = useState<WalletSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadSettings().then(setS, (e) => setErr(errText(e)));
  }, []);
  const fields = s ? Object.entries(s).filter(([, v]) => typeof v === "string" || typeof v === "number") : [];

  return (
    <section className="border-t border-neutral-900 pt-6">
      <h2 className="text-base font-semibold">Agent limits</h2>
      <p className="mt-1 text-sm text-neutral-400">Over a limit, the payment stops and asks for World Agent Pass.</p>
      {err && <p className="mt-3 text-sm text-red-300">Wallet settings unavailable: {err}</p>}
      {s && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveSettings(s).then(
              () => toast.success("Limits saved on this phone"),
              (x) => toast.error(`Couldn't save limits: ${errText(x)}`),
            );
          }}
        >
          {fields.map(([k, v]) => (
            <label key={k} className="block">
              <span className="text-sm text-neutral-300">{labelFor(k)}</span>
              <input
                value={String(v)}
                inputMode={typeof v === "number" ? "decimal" : "text"}
                onChange={(e) => {
                  setS({ ...s, [k]: typeof v === "number" ? Number(e.target.value) || 0 : e.target.value });
                }}
                className="mt-1 min-h-12 w-full rounded-xl border border-neutral-800 bg-transparent px-4 py-3 text-lg tabular-nums"
              />
            </label>
          ))}
          <button type="submit" className="min-h-12 w-full rounded-xl border border-neutral-800 px-5 font-semibold">
            Save limits
          </button>
        </form>
      )}
    </section>
  );
}

function labelFor(k: string): string {
  const words = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
