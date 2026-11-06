"use client";
// Background recipient (pay protocol v2) while the app is open: one relay connection with a fresh X25519 key,
// answering face probes (local template compare) and quotes (fresh one-time address + bound proof).
// Connects only when this phone holds a World ID card and isn't set to invisible.
//
// What lives where: template + card in the encrypted on-device vault; stealth keys derived on demand from the
// unlocked wallet; recent match nonces in memory. Probe bodies are dropped after one compare. Log lines here
// never carry embeddings, addresses or amounts.
import { Claim2Body, QrSecretBook, cpayQrText, generateKeyPair, type QuoteBody } from "@cpay/protocol";
import type { Card } from "@cpay/credential";
import { FACE_MODEL_ID } from "./face/engine.js";
import { fetchIssuerPublicKey } from "./issuer-client.js";
import { handlePay2Probe } from "./pay2-recipient.js";
import { publicConfig } from "./public-config.js";
import { RelayConnection, type RelayState } from "./relay-client.js";
import { VAULT, vaultGet, vaultSet } from "./vault.js";
import { answerQuote, chain, currentWallet, relayHelloProof, stealthKeysOf, type UnlockedWallet } from "./wallet.js";

export interface StoredTemplate {
  v: 1;
  model: string;
  template: number[];
  captures: number;
}

export interface RecipientStatus {
  relay: RelayState | "off";
  detail: string;
  /** this connection's X25519 pub (changes every connection) */
  pub: string | null;
  /** relay peer id of this connection (recipient.ready) (needed for the CPay QR) */
  peerId: string | null;
  hasCard: boolean;
  hasTemplate: boolean;
  invisible: boolean;
  showingCpayQr: boolean;
  /**
   * The CPay QR text to draw (`CPAY:1:<peerId>.<pub>.<qrSecret>`, upper-case), or null. Its secret is fresh every
   * time the QR is shown and after every answered QR quote; a quote must echo it.
   */
  cpayQr: string | null;
  log: { at: number; text: string }[];
  /** when the next automatic reconnect fires (ms epoch), or null when none is scheduled */
  reconnectAt: number | null;
}

/**
 * Privacy-safe recipient events for live UIs (Ready-to-receive screen). Fixed kinds only: never addresses,
 * amounts, embeddings, peer ids or relay-supplied text.
 */
export type RecipientEventKind =
  | "relay_open"
  | "relay_lost"
  | "probe_no_match"
  | "matched"
  | "quote_answered"
  | "quote_refused"
  | "quote_failed_locked"
  | "quote_failed";
export interface RecipientEvent {
  at: number;
  kind: RecipientEventKind;
}

const RECONNECT_MS = 3_000;

class RecipientService {
  status: RecipientStatus = {
    relay: "off",
    detail: "",
    pub: null,
    peerId: null,
    hasCard: false,
    hasTemplate: false,
    invisible: false,
    showingCpayQr: false,
    cpayQr: null,
    log: [],
    reconnectAt: null,
  };
  private qrSecrets = new QrSecretBook();
  private listeners = new Set<(s: RecipientStatus) => void>();
  private eventListeners = new Set<(e: RecipientEvent) => void>();
  private conn: RelayConnection | null = null;
  private secret: Uint8Array | null = null;
  private template: number[] | null = null;
  private card: Card | null = null;
  private recentMatches = new Map<string, number>();
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** the relay refused our World ID proof; cleared by start() (e.g. after a new card) */
  private refused = false;

  onStatus(fn: (s: RecipientStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }
  /** Subscribe to privacy-safe recipient events (see RecipientEvent). Returns an unsubscribe function. */
  onEvent(fn: (e: RecipientEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  private emit(kind: RecipientEventKind): void {
    const e = { at: Date.now(), kind };
    this.eventListeners.forEach((f) => f(e));
  }

  /** Skip the reconnect backoff: reconnect now if a connection is wanted and none is open. */
  reconnectNow(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    this.set({ reconnectAt: null });
    if (this.conn && !this.conn.isOpen) {
      const c = this.conn;
      this.conn = null;
      this.secret = null;
      c.close();
      this.set({ relay: "closed", pub: null, peerId: null });
    }
    this.apply();
  }

  private set(p: Partial<RecipientStatus>): void {
    const s = { ...this.status, ...p };
    const secret = this.qrSecrets.current();
    s.cpayQr = s.showingCpayQr && s.peerId && s.pub && secret ? cpayQrText(s.peerId, s.pub, secret) : null;
    this.status = s;
    this.listeners.forEach((f) => f(this.status));
  }
  private log(text: string): void {
    console.info(`[cpay/receive] ${text}`);
    this.set({ log: [{ at: Date.now(), text }, ...this.status.log].slice(0, 30) });
  }

  /** Load template/card/invisible from the vault and (re)connect if appropriate. Safe to call repeatedly. */
  async start(): Promise<void> {
    this.started = true;
    this.refused = false;
    let t: StoredTemplate | null = null;
    let c: Card | null = null;
    let inv = false;
    try {
      [t, c, inv] = await Promise.all([
        vaultGet<StoredTemplate>(VAULT.template),
        vaultGet<Card>(VAULT.card),
        vaultGet<boolean>(VAULT.invisible).then((v) => !!v),
      ]);
    } catch (e) {
      this.set({ relay: "off", detail: `on-device vault unavailable: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    // A template from another model can't be compared: treat as not enrolled.
    this.template = t && t.model === FACE_MODEL_ID ? t.template : null;
    this.card = c;
    this.set({ hasCard: !!c, hasTemplate: !!this.template, invisible: inv });
    this.apply();
  }

  async setInvisible(v: boolean): Promise<void> {
    await vaultSet(VAULT.invisible, v);
    this.set({ invisible: v });
    this.log(v ? "invisible: disconnected from the relay" : "visible again");
    this.apply();
  }

  /**
   * The Receive tab sets this while the private CPay QR may be on screen. Every show draws a fresh secret; hiding
   * forgets it, so a photo of an earlier QR can't get a quote answered.
   */
  setShowingCpayQr(v: boolean): void {
    if (this.status.showingCpayQr === v) return;
    if (v) this.qrSecrets.rotate();
    else this.qrSecrets.clear();
    this.set({ showingCpayQr: v });
  }

  /** The CPay QR text, or null until the relay connection is up (peer id known) and the QR is on screen. */
  cpayQr(): string | null {
    return this.status.cpayQr;
  }

  /** This phone's own relay identity: the payer side never probes itself. */
  self(): { peerId: string | null; pub: string | null } {
    return { peerId: this.status.peerId, pub: this.status.pub };
  }

  private apply(): void {
    const want = this.started && this.status.hasCard && !this.status.invisible;
    if (want && !this.conn) this.connect();
    if (!want && this.conn) this.disconnect(this.status.invisible ? "invisible" : "no World ID card on this phone");
    if (!want && !this.conn) {
      this.set({
        relay: "off",
        detail: this.status.invisible ? "invisible: not connected to any relay" : !this.status.hasCard ? "no World ID card on this phone" : "",
      });
    }
  }

  private disconnect(why: string): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    this.status.reconnectAt = null;
    const c = this.conn;
    this.conn = null;
    this.secret = null;
    this.recentMatches.clear();
    c?.close();
    this.set({ relay: "off", detail: why, pub: null, peerId: null });
  }

  private connect(): void {
    const kp = generateKeyPair(); // fresh per connection
    this.secret = kp.secretKey;
    this.recentMatches.clear();
    this.set({ pub: kp.publicKey, peerId: null });
    const c = new RelayConnection(publicConfig.relayUrl, {
      onMessage: (m) => {
        if (this.conn !== c) return;
        // The relay registers only verified humans: prove the card, bound to its challenge + our fresh key.
        if (m.type === "challenge") return void this.hello(c, m.nonce, kp.publicKey);
        if (m.type === "error") {
          // Card not accepted (e.g. last month's epoch): retrying every 3 s can't help. Re-verify with World instead.
          if (m.message === "recipient not verified") this.refused = true;
          return this.log(`relay: ${m.message}${this.refused ? " (re-verify with World ID below; not retrying)" : ""}`);
        }
        // The relay tells us our peer id: needed for the CPay QR and to never probe ourselves when paying.
        if (m.type === "recipient.ready") {
          if (this.status.showingCpayQr) this.qrSecrets.rotate(); // new connection, new QR: new secret too
          return this.set({ peerId: m.peerId });
        }
        if (m.type === "probe") void this.onProbe(c, m);
      },
      onState: (s, d) => {
        if (this.conn !== c) return;
        this.set({ relay: s, detail: d ?? "" });
        if (s === "open") this.emit("relay_open");
        if (s === "closed") {
          this.conn = null;
          this.secret = null;
          this.set({ pub: null, peerId: null });
          this.emit("relay_lost");
          if (d && !d.startsWith("page is HTTPS") && !this.refused) {
            this.set({ reconnectAt: Date.now() + RECONNECT_MS });
            this.reconnect = setTimeout(() => {
              this.reconnect = null;
              this.set({ reconnectAt: null });
              this.apply();
            }, RECONNECT_MS);
          }
        }
      },
    });
    this.conn = c;
    c.connect();
  }

  private async hello(c: RelayConnection, nonce: string, pub: string): Promise<void> {
    if (!this.card) return this.log("no World ID card: not registering on the relay");
    let proof: string;
    try {
      const issuerPublicKey = await fetchIssuerPublicKey(publicConfig.issuerUrl);
      proof = await relayHelloProof({ card: this.card, issuerPublicKey, nonce, pub });
    } catch (e) {
      return this.log(`could not prove World ID to the relay: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.conn !== c) return;
    c.send({ type: "recipient.hello", pub, proof });
  }

  private async onProbe(c: RelayConnection, msg: Parameters<typeof handlePay2Probe>[1]): Promise<void> {
    const secret = this.secret;
    if (!secret) return;
    let out;
    try {
      out = await handlePay2Probe(
        {
          secretKey: secret,
          template: this.template,
          threshold: publicConfig.faceMatchThreshold,
          chainId: chain().chainId,
          token: chain().usdc,
          showingCpayQr: () => this.status.showingCpayQr,
          qrSecrets: this.qrSecrets,
          onQrRotated: () => this.set({}),
          recentMatches: this.recentMatches,
          now: Date.now,
          answer: (q) => this.answer(q),
        },
        msg,
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.emit(why.startsWith("wallet locked") ? "quote_failed_locked" : "quote_failed");
      return this.log(`could not answer a quote: ${why} (stayed silent)`);
    }
    if (this.conn !== c) return;
    switch (out.kind) {
      case "ignored":
        return;
      case "no_match":
        this.emit("probe_no_match");
        return this.log("face probe: not me, stayed silent");
      case "matched":
        c.send(out.reply);
        this.emit("matched");
        this.log("face probe: MATCH, answered (sealed)");
        if (navigator.vibrate) navigator.vibrate(150);
        return;
      case "quote_refused":
        this.emit("quote_refused");
        return this.log(
          out.why === "wrong_chain"
            ? "quote for another chain/token: refused"
            : out.why === "rate_limited"
              ? "QR quote over the rate limit: refused"
              : "quote without a recent match or the secret of the QR on screen: refused",
        );
      case "claimed":
        c.send(out.reply);
        this.emit("quote_answered");
        this.log(`quote answered: fresh one-time address + World ID proof (sealed)${out.via === "qr" ? "; QR secret rotated" : ""}`);
        if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
        return;
    }
  }

  private async answer(q: QuoteBody) {
    const wallet: UnlockedWallet | null = currentWallet();
    if (!wallet) throw new Error("wallet locked: unlock CPay to receive privately");
    if (!this.card) throw new Error("no World ID card on this phone");
    const issuerPublicKey = await fetchIssuerPublicKey(publicConfig.issuerUrl);
    const body = await answerQuote({ quote: q, card: this.card, issuerPublicKey, stealthKeys: stealthKeysOf(wallet) });
    return Claim2Body.parse(body);
  }
}

let svc: RecipientService | null = null;
export function getRecipient(): RecipientService {
  svc ??= new RecipientService();
  return svc;
}
