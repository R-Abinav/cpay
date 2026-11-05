"use client";
// Step 4: be payable. Connect to the relay with a fresh X25519 key per connection; open each sealed probe,
// compare locally, answer only on a match (fresh one-time destination + BBS proof bound to bindingDigest).
// No match -> nothing is sent. "Invisible" disconnects from the relay entirely.
import { useCallback, useEffect, useRef, useState } from "react";
import { generateKeyPair, type RelayMessage } from "@cpay/protocol";
import { createOneTimeDestination, type StealthKeys } from "@cpay/stealth";
import { initCredential, prove, type Card } from "@cpay/credential";
import { Button, DepPill, ErrorNote, Mono, NotConnected, Section, short } from "../../components/ui.js";
import { errorMessage, isNotImplemented } from "../../lib/deps.js";
import { fetchIssuerPublicKey } from "../../lib/issuer-client.js";
import { ETHERSCAN_ADDR, publicConfig } from "../../lib/public-config.js";
import { handleProbe, handleQrClaim, type Destination, type OpenedProbe, type RecipientDeps } from "../../lib/recipient.js";
import { RelayConnection, type RelayState } from "../../lib/relay-client.js";
import { formatAmount } from "../../lib/units.js";
import { VAULT, vaultGet, vaultSet } from "../../lib/vault.js";
import { QrClaim } from "./qr-claim.js";

interface LogLine {
  at: number;
  text: string;
  tone: "info" | "match" | "warn";
}
interface StoredDestination extends Destination {
  sessionId: string;
  amount: string;
  at: string;
  via: "face" | "qr";
}

const PROBE_MEMORY_MS = 60_000; // relay forgets sessions after 60 s
const RECONNECT_MS = 3000;

export function ListenStep({ keys, template, card }: { keys: StealthKeys; template: number[]; card: Card | null }) {
  const [invisible, setInvisible] = useState<boolean | null>(null);
  const [relayState, setRelayState] = useState<RelayState>("closed");
  const [relayDetail, setRelayDetail] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [dests, setDests] = useState<StoredDestination[]>([]);
  const [proofErr, setProofErr] = useState<string | null>(null);
  const [probes, setProbes] = useState<OpenedProbe[]>([]);
  const conn = useRef<RelayConnection | null>(null);
  const secret = useRef<Uint8Array | null>(null);
  const reconnect = useRef<ReturnType<typeof setTimeout> | null>(null);

  const add = useCallback((text: string, tone: LogLine["tone"] = "info") => setLog((l) => [{ at: Date.now(), text, tone }, ...l].slice(0, 30)), []);

  useEffect(() => {
    vaultGet<boolean>(VAULT.invisible).then((v) => setInvisible(!!v));
    vaultGet<StoredDestination[]>(VAULT.destinations).then((d) => setDests(d ?? []));
  }, []);

  const deps = useCallback((): RecipientDeps => {
    if (!secret.current) throw new Error("not connected to relay");
    return {
      secretKey: secret.current,
      template,
      threshold: publicConfig.faceMatchThreshold,
      chainId: publicConfig.chainId,
      tokens: [publicConfig.usdcAddress],
      createDestination: () => createOneTimeDestination(keys),
      prove: async (digest) => {
        if (!card) throw new Error("matched, but no World ID card yet (finish step 3)");
        await initCredential();
        const pub = await fetchIssuerPublicKey(publicConfig.issuerUrl);
        return prove(card, pub, digest);
      },
    };
  }, [card, keys, template]);

  const remember = useCallback(async (d: Destination, p: OpenedProbe, via: "face" | "qr") => {
    const entry: StoredDestination = { ...d, sessionId: p.delivery.sessionId, amount: p.body.amount, at: new Date().toISOString(), via };
    const next = [entry, ...((await vaultGet<StoredDestination[]>(VAULT.destinations)) ?? [])].slice(0, 100);
    await vaultSet(VAULT.destinations, next);
    setDests(next);
  }, []);

  const onMessage = useCallback(
    async (msg: RelayMessage) => {
      if (msg.type === "error") return add(`relay: ${msg.message}`, "warn");
      if (msg.type !== "probe") return;
      let outcome;
      try {
        outcome = await handleProbe(deps(), msg);
      } catch (e) {
        const m = isNotImplemented(e) ? "credential not connected: matched, but can't prove (stayed silent)" : `could not answer: ${errorMessage(e)}`;
        setProofErr(m);
        return add(m, "warn");
      }
      if (outcome.kind === "unreadable") return add("probe not addressed to this key (ignored)");
      setProbes((ps) => [outcome.probe, ...ps.filter((p) => Date.now() - p.receivedAt < PROBE_MEMORY_MS)].slice(0, 20));
      const amt = `${formatAmount(BigInt(outcome.probe.body.amount), 6)} USDC`;
      if (outcome.kind === "wrong_chain") return add(`probe for another chain/token (${amt}): silent`, "warn");
      if (outcome.kind === "no_match") return add(`probe (${amt}): not my face, stayed silent`);
      conn.current?.send(outcome.claim);
      await remember(outcome.destination, outcome.probe, "face");
      add(`MATCH: answered ${amt} with one-time address ${short(outcome.destination.address)}`, "match");
      if (navigator.vibrate) navigator.vibrate(200);
    },
    [add, deps, remember],
  );

  const connect = useCallback(() => {
    if (reconnect.current) clearTimeout(reconnect.current);
    conn.current?.close();
    const kp = generateKeyPair(); // fresh per connection
    secret.current = kp.secretKey;
    const c = new RelayConnection(publicConfig.relayUrl, {
      onOpen: () => c.send({ type: "recipient.hello", pub: kp.publicKey }),
      onMessage: (m) => void onMessage(m),
      onState: (s, d) => {
        setRelayState(s);
        setRelayDetail(d ?? "");
        if (s === "closed" && conn.current === c && d !== undefined && !d.startsWith("page is HTTPS")) {
          reconnect.current = setTimeout(connect, RECONNECT_MS);
        }
      },
    });
    conn.current = c;
    c.connect();
  }, [onMessage]);

  useEffect(() => {
    if (invisible === null) return;
    if (invisible) {
      if (reconnect.current) clearTimeout(reconnect.current);
      const c = conn.current;
      conn.current = null;
      c?.close();
      secret.current = null;
      setRelayState("closed");
      setRelayDetail("invisible: not connected to any relay");
      return;
    }
    connect();
    return () => {
      if (reconnect.current) clearTimeout(reconnect.current);
      const c = conn.current;
      conn.current = null;
      c?.close();
    };
  }, [invisible, connect]);

  async function toggleInvisible() {
    const v = !invisible;
    await vaultSet(VAULT.invisible, v);
    setInvisible(v);
    add(v ? "invisible: disconnected, nobody can probe you" : "visible again");
  }

  async function qrClaim(p: OpenedProbe) {
    const r = await handleQrClaim(deps(), p);
    conn.current?.send(r.claim);
    await remember(r.destination, p, "qr");
    add(`QR claim sent for ${formatAmount(BigInt(p.body.amount), 6)} USDC`, "match");
  }

  const relayPill = relayState === "open" ? "ok" : relayState === "not_configured" ? "not_connected" : relayState === "connecting" ? "unknown" : "offline";

  return (
    <Section step={4} title="Receive payments">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <DepPill id="relay" state={invisible ? "unknown" : relayPill} detail={relayDetail} />
        </div>
        {!card && <NotConnected id="credential" detail="No World ID card yet: you'll be probed but can't answer until step 3 is done." />}
        {relayState === "not_configured" && <NotConnected id="relay" detail={relayDetail} />}

        <button
          onClick={toggleInvisible}
          aria-pressed={!!invisible}
          className={`flex min-h-16 w-full items-center justify-between rounded-2xl border px-5 text-left ${invisible ? "border-neutral-700 bg-neutral-800" : "border-emerald-500/50 bg-emerald-500/10"}`}
        >
          <span>
            <span className="block text-lg font-semibold">{invisible ? "Invisible" : "Payable by face"}</span>
            <span className="block text-xs text-neutral-400">{invisible ? "Not connected to the relay. Tap to become payable." : "Your phone answers only probes that match your face. Tap to go invisible."}</span>
          </span>
          <span className={`h-8 w-14 rounded-full p-1 ${invisible ? "bg-neutral-600" : "bg-emerald-500"}`}>
            <span className={`block h-6 w-6 rounded-full bg-white transition ${invisible ? "" : "translate-x-6"}`} />
          </span>
        </button>

        {proofErr && <ErrorNote>{proofErr}</ErrorNote>}

        <QrClaim probes={probes} onClaim={qrClaim} disabled={!card || !!invisible || relayState !== "open"} />

        <div>
          <h3 className="mb-2 text-sm font-semibold text-neutral-300">Activity (this phone only)</h3>
          <ul className="max-h-56 space-y-1 overflow-auto text-xs">
            {log.length === 0 && <li className="text-neutral-500">Waiting for probes…</li>}
            {log.map((l, i) => (
              <li key={`${l.at}-${i}`} className={l.tone === "match" ? "text-emerald-300" : l.tone === "warn" ? "text-amber-300" : "text-neutral-400"}>
                {new Date(l.at).toLocaleTimeString()} · {l.text}
              </li>
            ))}
          </ul>
        </div>

        {dests.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-neutral-300">One-time addresses you handed out</h3>
            <ul className="space-y-1 text-xs">
              {dests.slice(0, 10).map((d) => (
                <li key={d.address} className="flex justify-between gap-2">
                  <a className="underline" href={ETHERSCAN_ADDR(d.address)} target="_blank" rel="noreferrer noopener">
                    <Mono>{short(d.address)}</Mono>
                  </a>
                  <span className="text-neutral-500">
                    {formatAmount(BigInt(d.amount), 6)} USDC · {d.via}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
