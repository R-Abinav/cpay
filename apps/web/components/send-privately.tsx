"use client";
// "Send privately": pays straight from the one-time addresses (each signs its own transfer on this phone).
// The main wallet is never touched, so the payment is not linked to it on-chain.
import { useCallback, useState } from "react";
import { errText, toast } from "../lib/toast.js";
import {
  PartialSendError,
  parseQr,
  privateSendLegs,
  sendPrivately,
  toBaseUnits,
  txUrl,
  type OneTimeBalance,
  type PrivateSendLegView,
  type UnlockedWallet,
} from "../lib/wallet.js";
import { AddressScanner } from "./address-scanner.js";
import { Address } from "./ui.js";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const input = "mt-1 min-h-12 w-full rounded-xl border border-neutral-800 bg-transparent px-3 text-base";
const ghost = "min-h-12 flex-1 rounded-xl border border-neutral-800 px-3 text-sm font-semibold";
const primary = "min-h-12 flex-1 rounded-xl bg-emerald-500 px-3 text-sm font-semibold text-black disabled:opacity-40";

export function SendPrivately({
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
  const [sent, setSent] = useState<PrivateSendLegView[] | null>(null);

  const onScanned = useCallback((text: string) => {
    setScan(false);
    const q = parseQr(text);
    if (q.kind === "address") {
      setTo(q.address);
      if (q.amount) setAmount(q.amount);
    } else if (q.kind === "cpay") {
      toast.warn("That's a private CPay QR. Private sends go to a plain address for now; pay CPay QRs from the Pay tab.");
    } else {
      toast.warn(q.reason === "wrong_chain" ? "That QR is for another network." : "Not a wallet address QR.");
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
    try {
      const done = await sendPrivately(wallet, { to: to.trim(), amount: amount.trim() });
      setSent(done);
      const last = done[done.length - 1];
      toast.success(`Sent ${amount.trim()} USDC privately`, last ? { href: txUrl(last.hash), label: "View tx" } : undefined);
      setReview(false);
      setTo("");
      setAmount("");
    } catch (e) {
      if (e instanceof PartialSendError) setSent(e.done);
      toast.error(`Send failed: ${errText(e)}`);
    } finally {
      setSending(false);
      setBusy(null);
      await onSent();
    }
  }

  if (!open)
    return (
      <button onClick={() => setOpen(true)} disabled={disabled} className="mt-4 min-h-12 w-full rounded-xl bg-emerald-500 px-4 font-semibold text-black disabled:opacity-40">
        Send privately
      </button>
    );

  return (
    <div className="mt-4 rounded-2xl border border-neutral-800 p-4">
      <h3 className="font-semibold">Send privately</h3>
      <p className="mt-1 text-xs text-neutral-400">
        Pays straight from your one-time addresses, each signing on this phone. Your main wallet is not touched, so the payment is not linked
        to it on-chain. (Your RPC provider still sees the request from this phone.)
      </p>
      {!review ? (
        <>
          <label className="mt-4 block text-sm text-neutral-400">
            To (address)
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} className={`${input} font-mono text-sm`} />
          </label>
          {scan ? (
            <AddressScanner onText={onScanned} onClose={closeScan} />
          ) : (
            <button onClick={() => setScan(true)} className="mt-2 min-h-12 w-full rounded-xl border border-neutral-800 px-3 text-sm font-semibold">
              Scan address QR (phone camera)
            </button>
          )}
          <label className="mt-4 block text-sm text-neutral-400">
            Amount (USDC)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className={`${input} tabular-nums`} />
          </label>
          {isMain && <p className="mt-2 text-sm text-amber-300">That&apos;s your main wallet. Use &ldquo;Move to main wallet&rdquo; if you mean to link them.</p>}
          {isOwnOneTime && <p className="mt-2 text-sm text-amber-300">That&apos;s one of your own one-time addresses.</p>}
          {toOk && amtOk && legs === null && <p className="mt-2 text-sm text-amber-300">Private balance too low (or no gas left where the funds are).</p>}
          <div className="mt-4 flex gap-2">
            <button onClick={() => setOpen(false)} className={ghost}>
              Cancel
            </button>
            <button onClick={() => setReview(true)} disabled={!toOk || !amtOk || legs === null || isMain || isOwnOneTime || disabled} className={primary}>
              Review
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-sm">
            Send <b className="tabular-nums">{amount.trim()} USDC</b> to <Address value={to.trim()} label="destination address" /> from {legs} one-time address
            {legs === 1 ? "" : "es"}.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-neutral-400">
            <li>Your main wallet signs nothing and is not linked.</li>
            <li>The recipient sees which one-time address{legs === 1 ? "" : "es"} paid them, not who you are.</li>
            {legs !== null && legs > 1 && <li className="text-amber-300">Paying from {legs} addresses at once lets observers guess they belong to the same person.</li>}
            <li>Gas comes from each address&apos;s gas drop.</li>
          </ul>
          <div className="mt-4 flex gap-2">
            <button onClick={() => setReview(false)} disabled={sending} className={ghost}>
              Back
            </button>
            <button onClick={send} disabled={sending} className={primary}>
              {sending ? "Sending…" : "Confirm and send"}
            </button>
          </div>
        </>
      )}
      {sent && sent.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-neutral-300">
          {sent.map((l) => (
            <li key={l.hash}>
              {l.amount} USDC from <Address value={l.from} label="one-time address" /> ·{" "}
              <a className="text-emerald-300 underline" href={txUrl(l.hash)} target="_blank" rel="noreferrer noopener">
                tx ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
