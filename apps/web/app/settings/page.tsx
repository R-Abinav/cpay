"use client";
import { useEffect, useState } from "react";
import { PairingCode, PAIRING_CODE_ALPHABET } from "@cpay/glasses-kit/hub";
import { GlassesPill } from "../../components/app-shell.js";
import { WorldLink } from "../../components/world-link.js";
import { getHub } from "../../lib/hub-client.js";
import { useHubStatus } from "../../lib/hooks.js";
import { loadSettings, saveSettings, type WalletSettings } from "../../lib/wallet.js";

const allowed = new Set(PAIRING_CODE_ALPHABET.split(""));

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <GlassesPill />
      </header>
      <Glasses />
      <Caps />
      <WorldLink />
    </main>
  );
}

function Glasses() {
  const hub = useHubStatus();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = PairingCode.safeParse(code).success;
  const paired = hub.conn !== "unpaired" && hub.conn !== "no_hub";

  async function pair() {
    setBusy(true);
    setMsg(null);
    try {
      await getHub().pair(code);
      setMsg({ ok: true, text: "Paired. The glasses are linked to this phone only." });
      setCode("");
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h2 className="text-lg font-semibold">Glasses</h2>
      {hub.conn === "no_hub" && <p className="mt-2 text-sm text-amber-300">NEXT_PUBLIC_HUB_URL is not set in this build.</p>}
      {paired ? (
        <div className="mt-3 space-y-3">
          <p className="text-neutral-300">
            {hub.conn !== "connected" ? "Paired · connecting to hub…" : hub.online ? "Paired · glasses online" : "Paired · glasses offline"}
          </p>
          <button
            className="min-h-12 w-full rounded-xl bg-neutral-800 px-5 font-semibold text-red-300"
            onClick={() => {
              if (confirm("Unpair these glasses? They will show a new pairing code.")) getHub().unpair();
            }}
          >
            Unpair glasses
          </button>
        </div>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void pair();
          }}
        >
          <label className="block text-sm text-neutral-400" htmlFor="code">
            Type the 6-character code shown on your glasses
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
            onChange={(e) =>
              setCode(
                e.target.value
                  .toUpperCase()
                  .split("")
                  .filter((c) => allowed.has(c))
                  .join("")
                  .slice(0, 6),
              )
            }
            className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-4 text-center font-mono text-3xl tracking-[0.4em]"
            placeholder="ABC234"
          />
          <button
            type="submit"
            disabled={!valid || busy || hub.conn === "no_hub"}
            className="min-h-14 w-full rounded-xl bg-emerald-500 px-5 text-lg font-semibold text-black disabled:opacity-40"
          >
            {busy ? "Pairing…" : "Pair glasses"}
          </button>
        </form>
      )}
      {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
      {hub.lastError && !msg && <p className="mt-3 text-sm text-red-300">{hub.lastError}</p>}
      <p className="mt-4 text-xs text-neutral-500">
        The hub stores only a hash of a random token made on this phone. It forwards camera frames to this phone while you scan and keeps
        nothing (not end-to-end encrypted yet).
      </p>
    </section>
  );
}

/** Spend caps, edited generically from @cpay/wallet's settings object (stored on this phone only). */
function Caps() {
  const [s, setS] = useState<WalletSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    loadSettings().then(setS, (e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  const fields = s ? Object.entries(s).filter(([, v]) => typeof v === "string" || typeof v === "number") : [];

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h2 className="text-lg font-semibold">Agent limits</h2>
      <p className="mt-1 text-sm text-neutral-400">Over a limit, the payment stops and asks for World Agent Pass.</p>
      {err && <p className="mt-3 text-sm text-red-300">Wallet settings unavailable: {err}</p>}
      {s && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            saveSettings(s).then(
              () => setSaved(true),
              (x) => setErr(x instanceof Error ? x.message : String(x)),
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
                  setSaved(false);
                  setS({ ...s, [k]: typeof v === "number" ? Number(e.target.value) || 0 : e.target.value });
                }}
                className="mt-1 w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-lg"
              />
            </label>
          ))}
          <button type="submit" className="min-h-12 w-full rounded-xl bg-neutral-800 px-5 font-semibold">
            Save limits
          </button>
          {saved && <p className="text-sm text-emerald-300">Saved on this phone.</p>}
        </form>
      )}
    </section>
  );
}

function labelFor(k: string): string {
  const words = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
