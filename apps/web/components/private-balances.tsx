"use client";
// Wallet tab: money received privately sits on one-time addresses (one per payment). Listing them is local;
// reading their balances asks the RPC about all of them at once (it could link them), so it runs only on tap.
// "Send privately" pays straight from the one-time addresses (each signs its own transfer): the main wallet is
// never touched. "Move to main wallet" links the address to the agent wallet on-chain: the button says so.
import { useCallback, useState, useEffect } from "react";
import {
  NotConnectedError,
  PartialSendError,
  addressUrl,
  oneTimeBalances,
  oneTimeCount,
  parseQr,
  privateSendLegs,
  sendPrivately,
  sweepToAgent,
  toBaseUnits,
  txUrl,
  type OneTimeBalance,
  type PrivateSendLegView,
  type UnlockedWallet,
} from "../lib/wallet.js";
import { AddressScanner } from "./address-scanner.js";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export function PrivateBalances({ wallet, onSwept }: { wallet: UnlockedWallet; onSwept?: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [rows, setRows] = useState<OneTimeBalance[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; amount: string; ethHash: string | null } | null>(null);

  useEffect(() => {
    oneTimeCount().then(setCount, (e) => (e instanceof NotConnectedError ? setNotConnected(e.message) : setErr(msg(e))));
  }, []);

  async function check() {
    setBusy("check");
    setErr(null);
    try {
      setRows(await oneTimeBalances());
    } catch (e) {
      if (e instanceof NotConnectedError) setNotConnected(e.message);
      else setErr(`Balances unavailable: ${msg(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function moveToMain(r: OneTimeBalance) {
    if (
      !confirm(
        `Move ${r.usdc} USDC from ${short(r.address)} to your main (agent) wallet?\n\nThis PUBLICLY links the one-time address to your main wallet on-chain: anyone can then see they belong together. Its leftover gas ETH moves too.\n\nTo pay someone without linking, use "Send privately" instead.`,
      )
    )
      return;
    setBusy(r.address);
    setErr(null);
    try {
      const res = await sweepToAgent(wallet, r.address);
      setDone(res);
      onSwept?.();
      setRows(await oneTimeBalances());
    } catch (e) {
      setErr(`Move failed: ${msg(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const total = rows ? rows.reduce((s, r) => s + r.usdcRaw, 0n) : null;
  const fmt = (v: bigint) => {
    const s = v.toString().padStart(7, "0");
    const f = s.slice(-6).replace(/0+$/, "");
    return f ? `${s.slice(0, -6)}.${f}` : s.slice(0, -6);
  };

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h2 className="text-lg font-semibold">Private balance</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Money paid to your private CPay QR or face lands on a fresh one-time address each time.{" "}
        {count !== null && `${count} on this phone.`}
      </p>
      {notConnected ? (
        <p className="mt-3 text-sm text-amber-200">Not connected: {notConnected}</p>
      ) : (
        <>
          {total !== null && (
            <p className="mt-3 text-3xl font-bold">
              {fmt(total)} <span className="text-lg text-neutral-400">USDC</span>
            </p>
          )}
          <button
            onClick={check}
            disabled={busy !== null || count === 0}
            className="mt-3 min-h-12 w-full rounded-xl bg-neutral-800 px-4 font-semibold disabled:opacity-40"
          >
            {busy === "check" ? "Checking…" : rows ? "Refresh private balances" : "Check private balances"}
          </button>
          <p className="mt-1 text-xs text-neutral-500">Asks the RPC about all your one-time addresses at once (it could link them).</p>

          {rows && total !== null && total > 0n && (
            <SendPrivately
              wallet={wallet}
              rows={rows}
              disabled={busy !== null}
              setBusy={setBusy}
              onSent={async () => setRows(await oneTimeBalances().catch(() => rows))}
            />
          )}

          {rows && rows.length > 0 && (
            <ul className="mt-4 space-y-2">
              {rows.map((r) => (
                <li key={r.address} className="flex items-center justify-between gap-2 rounded-xl bg-neutral-950 px-3 py-2 text-sm">
                  <a href={addressUrl(r.address)} target="_blank" rel="noreferrer noopener" className="font-mono underline">
                    {short(r.address)}
                  </a>
                  <span className="text-neutral-300">{r.usdc} USDC</span>
                  <button
                    onClick={() => moveToMain(r)}
                    disabled={busy !== null || r.usdcRaw === 0n}
                    className="rounded-lg bg-amber-500/20 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-30"
                  >
                    {busy === r.address ? "Moving…" : "Move to main wallet (publicly links these addresses)"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {done && (
        <p className="mt-3 text-sm text-emerald-300">
          Moved {done.amount} USDC ·{" "}
          <a className="underline" href={txUrl(done.hash)} target="_blank" rel="noreferrer noopener">
            tx ↗
          </a>
          {done.ethHash && (
            <>
              {" "}
              · gas ETH{" "}
              <a className="underline" href={txUrl(done.ethHash)} target="_blank" rel="noreferrer noopener">
                tx ↗
              </a>
            </>
          )}
        </p>
      )}
      {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
    </section>
  );
}

function SendPrivately({
  wallet,
  rows,
  disabled,
  setBusy,
  onSent,
}: {
  wallet: UnlockedWallet;
  rows: OneTimeBalance[];
  disabled: boolean;
  setBusy: (b: string | null) => void;
  onSent: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [scan, setScan] = useState(false);
  const [review, setReview] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<PrivateSendLegView[] | null>(null);

  const onScanned = useCallback((text: string) => {
    setScan(false);
    const q = parseQr(text);
    if (q.kind === "address") {
      setTo(q.address);
      if (q.amount) setAmount(q.amount);
      setErr(null);
    } else if (q.kind === "cpay") {
      setErr("That's a private CPay QR. Private sends go to a plain address for now; pay CPay QRs from the Pay tab.");
    } else {
      setErr(q.reason === "wrong_chain" ? "That QR is for another network." : "Not a wallet address QR.");
    }
  }, []);
  const closeScan = useCallback(() => setScan(false), []);

  const toOk = isAddr(to.trim());
  const amtOk = (toBaseUnits(amount.trim()) ?? 0n) > 0n;
  const legs = toOk && amtOk ? privateSendLegs(rows, amount.trim()) : null;
  const isMain = toOk && to.trim().toLowerCase() === wallet.address.toLowerCase();
  const isOwnOneTime = toOk && rows.some((r) => r.address.toLowerCase() === to.trim().toLowerCase());

  async function send() {
    setSending(true);
    setBusy("send");
    setErr(null);
    try {
      setSent(await sendPrivately(wallet, { to: to.trim(), amount: amount.trim() }));
      setReview(false);
      setTo("");
      setAmount("");
    } catch (e) {
      if (e instanceof PartialSendError) setSent(e.done);
      setErr(`Send failed: ${msg(e)}`);
    } finally {
      setSending(false);
      setBusy(null);
      await onSent();
    }
  }

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="mt-4 min-h-12 w-full rounded-xl bg-emerald-600 px-4 font-semibold text-white disabled:opacity-40"
      >
        Send privately
      </button>
    );

  return (
    <div className="mt-4 rounded-xl border border-emerald-900 bg-emerald-950/30 p-4">
      <h3 className="font-semibold">Send privately</h3>
      <p className="mt-1 text-xs text-emerald-200/80">
        Pays straight from your one-time addresses, each signing on this phone. This does not touch your main wallet, so the payment
        is not linked to it on-chain. (Your RPC provider still sees the request from this phone.)
      </p>
      {!review ? (
        <>
          <label className="mt-3 block text-sm text-neutral-300">
            To (address)
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 min-h-11 w-full rounded-lg bg-neutral-950 px-3 font-mono text-sm"
            />
          </label>
          {scan ? (
            <AddressScanner onText={onScanned} onClose={closeScan} />
          ) : (
            <button onClick={() => setScan(true)} className="mt-2 min-h-11 w-full rounded-lg bg-neutral-800 px-3 text-sm font-semibold">
              Scan address QR (phone camera)
            </button>
          )}
          <label className="mt-3 block text-sm text-neutral-300">
            Amount (USDC)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="mt-1 min-h-11 w-full rounded-lg bg-neutral-950 px-3 text-sm"
            />
          </label>
          {isMain && <p className="mt-2 text-sm text-amber-200">That's your main wallet. Use "Move to main wallet" if you mean to link them.</p>}
          {isOwnOneTime && <p className="mt-2 text-sm text-amber-200">That's one of your own one-time addresses.</p>}
          {toOk && amtOk && legs === null && <p className="mt-2 text-sm text-amber-200">Private balance too low (or no gas left where the funds are).</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={() => setOpen(false)} className="min-h-11 flex-1 rounded-lg bg-neutral-800 px-3 text-sm font-semibold">
              Cancel
            </button>
            <button
              onClick={() => setReview(true)}
              disabled={!toOk || !amtOk || legs === null || isMain || isOwnOneTime || disabled}
              className="min-h-11 flex-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              Review
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm">
            Send <b>{amount.trim()} USDC</b> to <span className="font-mono">{short(to.trim())}</span> from {legs}{" "}
            one-time address{legs === 1 ? "" : "es"}.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-neutral-400">
            <li>Your main wallet signs nothing and is not linked.</li>
            <li>The recipient sees which one-time address{legs === 1 ? "" : "es"} paid them, not who you are.</li>
            {legs !== null && legs > 1 && (
              <li className="text-amber-200">
                Paying from {legs} addresses at once lets observers guess they belong to the same person.
              </li>
            )}
            <li>Gas comes from each address's gas drop.</li>
          </ul>
          <div className="mt-3 flex gap-2">
            <button onClick={() => setReview(false)} disabled={sending} className="min-h-11 flex-1 rounded-lg bg-neutral-800 px-3 text-sm font-semibold">
              Back
            </button>
            <button
              onClick={send}
              disabled={sending}
              className="min-h-11 flex-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              {sending ? "Sending…" : "Confirm and send"}
            </button>
          </div>
        </>
      )}
      {sent && sent.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-emerald-300">
          {sent.map((l) => (
            <li key={l.hash}>
              Sent {l.amount} USDC from {short(l.from)} ·{" "}
              <a className="underline" href={txUrl(l.hash)} target="_blank" rel="noreferrer noopener">
                tx ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
    </div>
  );
}
