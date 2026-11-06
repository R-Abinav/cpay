"use client";
import { useEffect, useState } from "react";
import {
  railgunAddress,
  railgunKeysOf,
  railgunUrl,
  shieldToRailgun,
  type RailgunKeys,
  type UnlockedWallet,
} from "../lib/wallet.js";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function RailgunCard({
  wallet,
  onUpdated,
}: {
  wallet: UnlockedWallet;
  onUpdated?: () => void;
}) {
  const [keys, setKeys] = useState<RailgunKeys | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState<string>("5.0");
  const [showShield, setShowShield] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<{ txHash: string; explorerUrl: string } | null>(null);

  useEffect(() => {
    try {
      setKeys(railgunKeysOf(wallet));
    } catch {
      setKeys(null);
    }
  }, [wallet]);

  async function handleShield() {
    if (!amount || parseFloat(amount) <= 0) {
      setErr("Enter a valid amount to shield");
      return;
    }
    setBusy(true);
    setErr(null);
    setLastTx(null);
    try {
      const res = await shieldToRailgun(wallet, amount);
      setLastTx(res);
      setShowShield(false);
      onUpdated?.();
    } catch (e) {
      setErr(`Shielding failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const rAddr = railgunAddress();
  const shortRailgun = `${rAddr.slice(0, 6)}…${rAddr.slice(-4)}`;

  return (
    <section className="rounded-2xl border border-indigo-900/40 bg-gradient-to-b from-indigo-950/20 to-neutral-900/60 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🛡️</span>
          <h2 className="text-lg font-semibold text-indigo-100">Railgun ZK Privacy</h2>
        </div>
        <span className="rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-400 border border-indigo-500/20">
          Ethereum Sepolia
        </span>
      </div>

      <p className="mt-1 text-sm text-neutral-400">
        Shields your USDC into Railgun’s privacy pool. The proof hides which note is spent, while top-up and withdrawal amounts and timing remain public at the pool boundary.
      </p>

      <div className="mt-4 rounded-xl bg-neutral-950/70 p-4 border border-neutral-800/80 space-y-2">
        <div className="flex items-center justify-between text-xs text-neutral-400">
          <span>Official Smart Wallet:</span>
          <a
            href={railgunUrl()}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-indigo-400/90 underline hover:text-indigo-300"
          >
            {shortRailgun} ↗
          </a>
        </div>

        {keys && (
          <div>
            <span className="text-xs text-neutral-500">Your Private 0zk Address:</span>
            <p className="font-mono text-xs text-neutral-300 break-all select-all mt-0.5 bg-neutral-900/80 p-2 rounded-lg">
              {keys.railgunAddress}
            </p>
          </div>
        )}
      </div>

      {lastTx && (
        <div className="mt-3 rounded-xl bg-indigo-950/40 border border-indigo-800/50 p-3 text-sm">
          <p className="text-indigo-300 font-medium">USDC Shielded to Railgun!</p>
          <a
            href={lastTx.explorerUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 block font-mono text-xs text-indigo-400 underline break-all"
          >
            {lastTx.txHash} ↗
          </a>
        </div>
      )}

      {err && <p className="mt-3 text-sm text-red-300">{err}</p>}

      {!showShield ? (
        <button
          onClick={() => {
            setErr(null);
            setShowShield(true);
          }}
          className="mt-4 w-full rounded-xl bg-indigo-500 hover:bg-indigo-400 px-4 py-3 text-sm font-semibold text-white transition"
        >
          + Top Up Railgun Balance (Shield USDC)
        </button>
      ) : (
        <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-200">Top Up Private Railgun Pool</h3>
            <button
              onClick={() => setShowShield(false)}
              className="text-xs text-neutral-400 hover:text-white"
            >
              Cancel
            </button>
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">Amount (USDC)</label>
            <input
              type="number"
              step="any"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg bg-neutral-900 border border-neutral-800 px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-indigo-500"
              placeholder="5.0"
            />
          </div>

          <p className="text-xs text-neutral-400">
            Shields USDC ahead of time into your Railgun balance. This is the only public transaction by the payer; payments are then unshielded straight to fresh one-time addresses via the broadcaster without ever exposing your agent wallet or gas.
          </p>

          <button
            onClick={handleShield}
            disabled={busy}
            className="w-full rounded-xl bg-indigo-500 hover:bg-indigo-400 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 transition"
          >
            {busy ? "Shielding into Railgun…" : "Confirm Top Up"}
          </button>
        </div>
      )}
    </section>
  );
}
