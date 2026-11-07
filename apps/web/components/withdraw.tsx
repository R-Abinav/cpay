"use client";
// Withdraw: move your test funds out to any wallet you like (MetaMask, Coinbase Wallet, Rainbow, a CEX deposit address…).
// Sources:
//   - Private balance (Railgun): unshield via the same bundled UserOperation as a private payment. The proof is made on this
//     phone; on-chain the destination and amount are visible, the sender (you) is not.
//   - Agent wallet: a plain transfer (USDC or ETH), fully visible, and it links your agent wallet to the destination.
//   - Received payments: the one-time addresses' own "Send privately" (each pays directly; your main wallet is untouched).
// Everything is signed on this phone after an explicit tap. Nothing is stored or sent anywhere else.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AddressScanner } from "./address-scanner.js";
import { errText, toast } from "../lib/toast.js";
import { sendFailure } from "../lib/pay-errors.js";
import { canPayPrivately, getRailgun, railgunStore, refreshPrivate } from "../lib/railgun.js";
import { Address } from "./ui.js";
import {
  addressUrl,
  broadcastTx,
  fmtUnits,
  parseQr,
  payDirect,
  signTx,
  toBaseUnits,
  txUrl,
  waitTx,
  type UnlockedWallet,
} from "../lib/wallet.js";

type Source = "private" | "public-usdc" | "public-eth";
type Phase = { k: "form" } | { k: "review" } | { k: "sending"; stage: string } | { k: "done"; hash: string } | { k: "unconfirmed"; reason: string; hash?: string };

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** ETH kept back for the transfer's own gas when using "Max". */
const ETH_GAS_RESERVE = 0.0003;

const STAGE: Record<string, string> = {
  proving: "Making the zero-knowledge proof on this phone (about 1–2 min)…",
  submitting: "Submitting through the bundler…",
  confirming: "Waiting for the block…",
};

function parseEth(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{0,18}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string }) => Promise<unknown> };
  }
}

export function Withdraw({
  wallet,
  balances,
  onDone,
  onClose,
}: {
  wallet: UnlockedWallet;
  balances: { eth: string; usdc: string } | null;
  onDone: () => void;
  onClose: () => void;
}) {
  const rg = useSyncExternalStore(railgunStore.subscribe, railgunStore.get, railgunStore.get);
  const privValid = rg.balances?.usdc.valid;
  const [source, setSource] = useState<Source>(privValid && privValid > 0n ? "private" : "public-usdc");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [scan, setScan] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "form" });
  const [checking, setChecking] = useState(false);
  const [injected, setInjected] = useState(false);

  useEffect(() => setInjected(typeof window !== "undefined" && !!window.ethereum), []);
  const busy = phase.k === "sending";

  // Close on Escape (not while sending: the transfer can't be recalled, so we keep showing its progress).
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [busy, onClose]);

  const onScanned = useCallback((text: string) => {
    setScan(false);
    const q = parseQr(text);
    if (q.kind === "address") {
      setTo(q.address);
      if (q.amount) setAmount(q.amount);
    } else if (q.kind === "cpay") toast.warn("That's a CPay QR. Withdraw to a plain wallet address (0x…).");
    else toast.warn(q.reason === "wrong_chain" ? "That QR is for another network." : "Not a wallet address QR.");
  }, []);
  const closeScan = useCallback(() => setScan(false), []);

  async function paste() {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      const m = /0x[0-9a-fA-F]{40}/.exec(t);
      if (m) setTo(m[0]);
      else toast.warn("No 0x address on the clipboard");
    } catch {
      toast.error("Couldn't read the clipboard. Paste into the field instead.");
    }
  }

  async function fromInjected() {
    try {
      const accts = (await window.ethereum!.request({ method: "eth_requestAccounts" })) as string[];
      if (accts?.[0] && isAddr(accts[0])) setTo(accts[0]);
      else toast.warn("The wallet returned no address");
    } catch (e) {
      toast.error(`Wallet didn't connect: ${errText(e)}`);
    }
  }

  const token = source === "public-eth" ? "ETH" : "USDC";
  const base = token === "ETH" ? parseEth(amount) : toBaseUnits(amount.trim());
  const toT = to.trim();
  const toOk = isAddr(toT);
  const isSelf = toOk && toT.toLowerCase() === wallet.address.toLowerCase();
  const amtOk = base !== null && base > 0n;
  const pubUsdc = balances ? Number(balances.usdc) : null;
  const pubEth = balances ? Number(balances.eth) : null;
  const overPublic =
    amtOk &&
    ((source === "public-usdc" && pubUsdc !== null && Number(amount) > pubUsdc) || (source === "public-eth" && pubEth !== null && Number(amount) > pubEth));

  function max() {
    if (source === "public-usdc" && balances) setAmount(balances.usdc);
    else if (source === "public-eth" && pubEth !== null) setAmount(Math.max(0, pubEth - ETH_GAS_RESERVE).toFixed(6).replace(/\.?0+$/, ""));
    else if (source === "private" && privValid !== undefined) {
      // Railgun takes 0.25% on the way out: the most that can arrive is valid / 1.0025.
      setAmount(fmtUnits((privValid * 10_000n) / 10_025n, 6));
    }
  }

  async function review() {
    if (source !== "private") return setPhase({ k: "review" });
    setChecking(true);
    try {
      const r = await canPayPrivately(wallet, base!, 0n);
      if (r.ok) return setPhase({ k: "review" });
      toast.warn(
        r.reason === "weth"
          ? "Not enough spendable private ETH for the fee (needs 0.004). Top up privately with a little ETH first."
          : "Not enough spendable private USDC (amount + 0.25% fee). Top up privately, wait ~2 min, then try again.",
      );
    } catch (e) {
      toast.error(`Private balance unavailable: ${errText(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function send() {
    setPhase({ k: "sending", stage: source === "private" ? "Preparing…" : "Signing on this phone…" });
    let stage: string | undefined;
    let sentHash: string | undefined;
    try {
      let hash: string;
      if (source === "private") {
        const client = await getRailgun(wallet);
        const r = await client.pay({
          amount: base!,
          to: toT as `0x${string}`,
          gasDropWei: 0n,
          onStage: (s) => {
            stage = s;
            setPhase({ k: "sending", stage: STAGE[s] ?? s });
          },
        });
        hash = r.txHash;
        void refreshPrivate(wallet).catch(() => undefined);
      } else if (source === "public-usdc") {
        setPhase({ k: "sending", stage: "Sending USDC…" });
        hash = await payDirect(wallet, { to: toT, amount: amount.trim(), token: "USDC" });
      } else {
        const s = await signTx(wallet, { to: toT as `0x${string}`, data: "0x", value: base! });
        sentHash = s.hash;
        await broadcastTx(s.raw);
        setPhase({ k: "sending", stage: "Waiting for the block…" });
        if ((await waitTx(s.hash)) === "reverted") throw new Error(`reverted on chain (${s.hash})`);
        hash = s.hash;
      }
      setPhase({ k: "done", hash });
      toast.success(`Withdrew ${amount.trim()} ${token}`, { href: txUrl(hash), label: "View tx" });
      onDone();
    } catch (e) {
      // It may still be on-chain if it went out: never offer a one-tap retry then (no double withdraw).
      const f = sendFailure(e, stage);
      if (sentHash || f.maybeSent) {
        setPhase({ k: "unconfirmed", reason: errText(e), hash: sentHash });
        toast.error("Withdraw unconfirmed — check Etherscan before trying again");
      } else {
        toast.error(`Withdraw failed: ${errText(e)}. Nothing was sent.`);
        setPhase({ k: "review" });
      }
    }
  }

  const sources: { id: Source; title: string; sub: string; bal: string }[] = [
    {
      id: "private",
      title: "Private balance · sender hidden",
      sub: "Railgun. Sender hidden among Railgun users; the amount and timing can still link it to your top-up (small testnet pool). 0.25% fee.",
      bal: privValid !== undefined ? `${fmtUnits(privValid, 6)} USDC spendable` : rg.status === "ready" ? "0 USDC spendable" : "not loaded",
    },
    {
      id: "public-usdc",
      title: "Agent wallet · USDC · public",
      sub: "A plain transfer. Links this agent wallet, and every public payment it made, to that address.",
      bal: balances ? `${balances.usdc} USDC` : "…",
    },
    {
      id: "public-eth",
      title: "Agent wallet · ETH · public",
      sub: "Send back leftover Sepolia ETH. Links the same way as the USDC transfer.",
      bal: balances ? `${balances.eth} ETH` : "…",
    },
  ];

  const field = "mt-1 block min-h-12 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-4 text-base text-neutral-100 outline-none focus:border-neutral-600";

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60" role="presentation" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wd-title"
        onClick={(e) => e.stopPropagation()}
        className="cpay-rise mx-auto flex max-h-[92dvh] w-full max-w-xl flex-col rounded-t-3xl border-t border-neutral-800 bg-neutral-950"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <h2 id="wd-title" className="text-lg font-semibold">
            Withdraw
          </h2>
          <button onClick={onClose} disabled={busy} className="min-h-11 px-2 text-sm text-neutral-400 disabled:opacity-30">
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 pb-5">
          {phase.k === "form" && (
            <>
              <div>
                <p className="text-sm text-neutral-400">To any wallet address (Ethereum Sepolia)</p>
                <input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="0x… destination address"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Destination address"
                  className={`${field} font-mono text-sm`}
                />
                <div className={`mt-2 grid gap-2 ${injected ? "grid-cols-3" : "grid-cols-2"}`}>
                  <button onClick={() => void paste()} className="min-h-11 rounded-xl border border-neutral-800 text-sm font-semibold">
                    Paste
                  </button>
                  <button onClick={() => setScan((s) => !s)} className="min-h-11 rounded-xl border border-neutral-800 text-sm font-semibold">
                    {scan ? "Stop scan" : "Scan QR"}
                  </button>
                  {injected && (
                    <button onClick={() => void fromInjected()} className="min-h-11 rounded-xl border border-neutral-800 text-sm font-semibold">
                      Connected wallet
                    </button>
                  )}
                </div>
                {scan && (
                  <div className="mt-2">
                    <AddressScanner onText={onScanned} onClose={closeScan} />
                  </div>
                )}
                <p className="mt-2 text-xs text-neutral-500">In your wallet app, tap Receive to copy the address or show its QR.</p>
                {to && !toOk && <p className="mt-1 text-sm text-amber-300">That isn&apos;t a 0x address.</p>}
                {isSelf && <p className="mt-1 text-sm text-amber-300">That&apos;s this wallet. Pick another destination.</p>}
              </div>

              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm text-neutral-400">From</legend>
                {sources.map((s) => (
                  <label
                    key={s.id}
                    className={`flex cursor-pointer gap-3 rounded-2xl border p-3 ${source === s.id ? "border-emerald-500/60 bg-emerald-500/5" : "border-neutral-800"}`}
                  >
                    <input type="radio" name="wd-src" className="mt-1 accent-emerald-500" checked={source === s.id} onChange={() => setSource(s.id)} />
                    <span className="min-w-0">
                      <span className="block font-semibold">{s.title}</span>
                      <span className="block text-xs text-neutral-400">{s.sub}</span>
                      <span className="mt-1 block text-xs tabular-nums text-neutral-300">{s.bal}</span>
                    </span>
                  </label>
                ))}
                <p className="text-xs text-neutral-500">For money on one-time addresses, use Send privately under Received privately.</p>
              </fieldset>

              <label className="block text-sm text-neutral-400">
                Amount ({token})
                <div className="flex gap-2">
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className={`${field} tabular-nums`} />
                  <button onClick={max} type="button" className="mt-1 min-h-12 shrink-0 rounded-xl border border-neutral-800 px-4 text-sm font-semibold text-neutral-200">
                    Max
                  </button>
                </div>
              </label>
              {overPublic && <p className="text-sm text-amber-300">More than the agent wallet holds.</p>}

              <button
                onClick={() => void review()}
                disabled={!toOk || isSelf || !amtOk || overPublic || checking}
                className="min-h-14 w-full rounded-2xl bg-emerald-500 text-lg font-semibold text-black disabled:opacity-30"
              >
                {checking ? "Checking private balance…" : "Review"}
              </button>
            </>
          )}

          {phase.k === "review" && (
            <>
              <div className="rounded-2xl border border-neutral-800 p-4">
                <p className="text-sm text-neutral-400">You&apos;re sending</p>
                <p className="mt-1 text-3xl font-semibold tabular-nums">
                  {amount.trim()} <span className="text-lg text-neutral-500">{token}</span>
                </p>
                <p className="mt-2 text-sm">
                  to <Address value={toT} label="destination address" />
                </p>
                <p className="mt-1 text-sm text-neutral-400">from {sources.find((s) => s.id === source)!.title}</p>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-400">
                {source === "private" ? (
                  <>
                    <li>Railgun adds 0.25% on top; a little private ETH pays the fee. Takes about 2 minutes (the proof is made here).</li>
                    <li>On-chain: the destination and amount are public. The sender is hidden among Railgun users, but withdrawing about what you just topped up, soon after, can still be linked by amount and timing.</li>
                    <li>Testnet: what's left in the private balance after this can't be spent again until a new top-up.</li>
                  </>
                ) : (
                  <li className="text-amber-300">Public: links this agent wallet, and every public payment it has made, to that address. Prefer the private balance.</li>
                )}
                <li>Signed on this phone. A transfer can't be undone: check the address.</li>
              </ul>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setPhase({ k: "form" })} className="min-h-14 rounded-2xl border border-neutral-800 font-semibold">
                  Back
                </button>
                <button onClick={() => void send()} className="min-h-14 rounded-2xl bg-emerald-500 font-semibold text-black">
                  Confirm
                </button>
              </div>
            </>
          )}

          {phase.k === "sending" && (
            <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 py-8 text-center">
              <span className="cpay-orb h-4 w-4 rounded-full bg-emerald-400" aria-hidden />
              <p className="font-semibold">
                Withdrawing {amount.trim()} {token}
              </p>
              <p className="text-sm text-neutral-400">{phase.stage}</p>
              <p className="text-xs text-neutral-600">Keep this screen open.</p>
            </div>
          )}

          {phase.k === "unconfirmed" && (
            <div className="space-y-3 py-4 text-center">
              <p className="text-lg font-semibold text-amber-300">Unconfirmed</p>
              <p className="text-sm text-neutral-400">It may still arrive. Check Etherscan before trying again, so you don&apos;t send twice.</p>
              <a
                href={phase.hash ? txUrl(phase.hash) : addressUrl(source === "private" ? toT : wallet.address)}
                target="_blank"
                rel="noreferrer noopener"
                className="block min-h-11 py-2 text-sm text-emerald-300 underline"
              >
                Check on Etherscan ↗
              </a>
              <button onClick={onClose} className="min-h-12 w-full rounded-2xl border border-neutral-800 font-semibold">
                Close
              </button>
            </div>
          )}

          {phase.k === "done" && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="cpay-pop grid h-16 w-16 place-items-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/40">
                <svg viewBox="0 0 48 48" className="h-9 w-9 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path className="cpay-draw" d="M12 25l8 8 16-17" />
                </svg>
              </div>
              <p className="text-lg font-semibold">
                Sent {amount.trim()} {token}
              </p>
              <a href={txUrl(phase.hash)} target="_blank" rel="noreferrer noopener" className="min-h-11 py-2 text-sm text-emerald-300 underline">
                View on Etherscan ↗
              </a>
              <button onClick={onClose} className="min-h-12 w-full rounded-2xl border border-neutral-800 font-semibold">
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
