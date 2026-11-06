"use client";
// Payer side of one pay-protocol-v2 round over the relay. Each round uses its OWN short-lived payer connection
// (payer.hello -> peers -> one probe -> claims for a fixed window -> close), so rounds can't be linked by
// connection on the relay either. Payloads are ciphertext only; nothing here logs their content.
import type { ClaimDelivery, Peer, ProbeRequest } from "@cpay/protocol";
import { publicConfig } from "./public-config.js";
import { RelayConnection } from "./relay-client.js";

export class RelayUnavailable extends Error {}

export interface RoundResult {
  /** online peers the relay listed (after excluding this phone) */
  peerCount: number;
  /** false when build() declined (e.g. no peers / target gone): nothing was sent */
  sent: boolean;
  claims: ClaimDelivery[];
  bytesSent: number;
}

export interface RoundOptions {
  /** this phone's own recipient identity: never probe ourselves */
  exclude?: { peerId: string | null; pub: string | null };
  /** collect answers this long after the probe is sent */
  waitMs: number;
  /** stop early once this says so (e.g. a claim that opens) */
  done?: (claims: readonly ClaimDelivery[]) => boolean;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
}

/** Run one round. `build` receives the online peers (minus this phone) and returns the probe, or null to send nothing. */
export function runRound(build: (peers: Peer[]) => ProbeRequest | null, opts: RoundOptions): Promise<RoundResult> {
  return new Promise<RoundResult>((resolve, reject) => {
    const claims: ClaimDelivery[] = [];
    let peerCount = 0;
    let sent = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const bytesSent = conn.bytesSent;
      conn.close();
      if (err) reject(err);
      else resolve({ peerCount, sent, claims, bytesSent });
    };
    const onAbort = () => finish(new DOMException("aborted", "AbortError"));
    if (opts.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    opts.signal?.addEventListener("abort", onAbort);

    const conn = new RelayConnection(publicConfig.relayUrl, {
      onOpen: () => conn.send({ type: "payer.hello" }),
      onState: (s, detail) => {
        if (s === "not_configured") finish(new RelayUnavailable(detail ?? "relay not configured"));
        else if (s === "closed" && !settled) finish(sent ? undefined : new RelayUnavailable(detail ?? "relay closed"));
      },
      onMessage: (m) => {
        if (settled) return;
        if (m.type === "error") {
          if (!sent) finish(new RelayUnavailable(`relay: ${m.message}`));
          return;
        }
        if (m.type === "peers" && !sent) {
          const ex = opts.exclude;
          const peers = m.peers.filter((p) => !ex || (p.peerId !== ex.peerId && p.pub !== ex.pub));
          peerCount = peers.length;
          const probe = build(peers);
          if (!probe) return finish();
          conn.send(probe);
          sent = true;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => finish(), opts.waitMs);
          return;
        }
        if (m.type === "claim" && sent) {
          claims.push(m);
          if (opts.done?.(claims)) finish();
        }
      },
    });
    timer = setTimeout(() => finish(new RelayUnavailable("relay did not answer")), opts.connectTimeoutMs ?? 5_000);
    conn.connect();
  });
}
