"use client";
import { useEffect, useState } from "react";
import { PairingCode } from "@cpay/glasses-kit/hub";
import { GlassesPill, Page } from "../../components/app-shell.js";
import { FaceEnrol, useStoredTemplate } from "../../components/face-enrol.js";
import { WorldLink } from "../../components/world-link.js";
import { DeleteAccount } from "../../components/delete-account.js";
import { cleanPairCode, getHub, glassesState, GLASSES_TEXT } from "../../lib/hub-client.js";
import { askEnabled, setAskEnabled } from "../../lib/ask-pay.js";
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
      <DeleteAccount />
    </Page>
  );
}

/** Face pay: enrol, re-enrol (old template kept until the new one is saved) or remove. Deep link: /settings#face. */
function Face() {
  const [template, setTemplate] = useStoredTemplate();
  const loaded = template !== undefined;
  // The section renders only after the vault opens, so the browser's own #face jump can miss it.
  useEffect(() => {
    if (loaded && location.hash === "#face") document.getElementById("face")?.scrollIntoView({ block: "start" });
  }, [loaded]);
  return (
    <div id="face" className="scroll-mt-20">
      {loaded && <FaceEnrol template={template} onTemplate={(t) => void setTemplate(t)} title="Face pay" />}
    </div>
  );
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
      <p role="status" className={`mt-1 text-sm ${state === "restarted" ? "text-amber-300" : state === "paired" ? "text-emerald-300" : "text-neutral-400"}`}>
        {GLASSES_TEXT[state]}
        {state === "offline" && <span className="text-neutral-500"> · power them on</span>}
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
            Code on the glasses
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
            className="w-full rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-4 text-center font-mono text-3xl uppercase tracking-[0.3em] placeholder:text-neutral-700 focus:border-emerald-500/60 focus:outline-none"
            placeholder="ABC234"
          />
          <button
            type="submit"
            disabled={!valid || busy}
            className="min-h-14 w-full rounded-2xl bg-emerald-500 px-5 text-lg font-semibold text-black hover:bg-emerald-400 disabled:opacity-40"
          >
            {busy ? "Pairing…" : "Pair glasses"}
          </button>
        </form>
      ) : state === "paired" || state === "offline" || state === "connecting" ? (
        <div className="mt-3">
          <button
            type="button"
            className="min-h-12 w-full rounded-2xl border border-neutral-800 px-5 font-semibold text-neutral-300 hover:bg-neutral-900"
            onClick={() => {
              if (confirm("Unpair these glasses? They will show a new pairing code.")) getHub().unpair();
            }}
          >
            Unpair glasses
          </button>
        </div>
      ) : null}
      {hub.lastError && <p className="mt-3 text-sm text-red-300">{hub.lastError}</p>}
      <AskToggle />
      <p className="mt-3 text-xs text-neutral-500">Camera frames pass through our hub only while you scan and are never stored (not end-to-end encrypted yet).</p>
    </section>
  );
}

/** Hands-free start: ask "Want to pay?" when the glasses connect (and after each payment). Stored on this phone. */
function AskToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => setOn(askEnabled()), []);
  if (on === null) return null;
  return (
    <label className="mt-4 flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-neutral-800 px-4 py-3 text-sm">
      <span>
        <span className="block font-medium">Ask &ldquo;Want to pay?&rdquo;</span>
        <span className="block text-xs text-neutral-500">When glasses connect, on the Pay tab. Say yes to scan.</span>
      </span>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setAskEnabled(e.target.checked);
          setOn(e.target.checked);
        }}
        className="h-5 w-5 shrink-0 accent-emerald-500"
      />
    </label>
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
      <p className="mt-1 text-sm text-neutral-400">Over a limit, World Agent Pass checks it&apos;s really you. Stored on this phone.</p>
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
              <span className="text-sm text-neutral-400">{labelFor(k)}</span>
              <input
                value={String(v)}
                inputMode={typeof v === "number" ? "decimal" : "text"}
                onChange={(e) => {
                  setS({ ...s, [k]: typeof v === "number" ? Number(e.target.value) || 0 : e.target.value });
                }}
                className="mt-1.5 min-h-12 w-full rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-lg tabular-nums focus:border-emerald-500/60 focus:outline-none"
              />
            </label>
          ))}
          <button type="submit" className="min-h-12 w-full rounded-2xl border border-neutral-800 px-5 font-semibold hover:bg-neutral-900">
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
