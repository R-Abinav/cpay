"use client";
// Drives one /pay session: performs the I/O for each step of lib/pay-machine.ts and feeds results back.
// Order is fixed (invariant 7): QR destination -> 0G amount -> policy -> spoken confirm code -> sign on phone.
//
// Feedback for a wearer whose phone is in their pocket: every step sets the OLED, speaks a fixed template (voices
// are queued, never overlapping, and the mic never opens while one plays), and the phone's status line
// (lib/pay-status.ts) says the same. Every async path ends in a visible state; a send is never retried.
//
// "Want to pay?" (lib/ask-pay.ts): when your glasses come online (and after each payment ends) the phone asks once,
// opens the mic for 5 s and a deterministic matcher decides. Tapping Scan or Stop cancels it at any time.
import { oledStates } from "@cpay/glasses-kit/hub";
import { glassesState, glassesUp, type HubClient, type FrameMsg, type HubStatus } from "../../lib/hub-client.js";
import { initialPayState, isActive as isActiveState, payReducer, type PayEvent, type PayState, type Recipient } from "../../lib/pay-machine.js";
import { askEnabled, askReducer, initialAsk, matchWantToPay, shouldAsk, type AskEvent, type AskPhase, type AskState } from "../../lib/ask-pay.js";
import { micErrorText, sendFailure, withTimeout } from "../../lib/pay-errors.js";
import { decodeQrFromJpeg, frameBlob } from "../../lib/frame-qr.js";
import { beep, record, unlockAudio, type Recording } from "../../lib/voice-io.js";
import { sayWithToast } from "../../lib/voice-feedback.js";
import { errText, toast } from "../../lib/toast.js";
import {
  BrainOffline,
  intentFromAudio,
  transcribe,
  type EvidenceLine,
  type SpeakTemplate,
} from "../../lib/zg-client.js";
import { linkedSubHash, openApprovalWindow, runAgentPass } from "../../lib/agent-pass-client.js";
import {
  approvalBinding,
  approvalCommit,
  evaluatePolicy,
  matchConfirm,
  newConfirmCode,
  parseQr,
  payDirect,
  recordSpend,
  toBaseUnits,
  txUrl,
  unsupportedWhy,
  verifyApproval,
  type ApprovalBindingJson,
  type UnlockedWallet,
} from "../../lib/wallet.js";
import { PAY_LIMITS } from "../../lib/pay-machine.js";
import { PrivateFlow } from "./private-flow.js";
import { canPayPrivately, getRailgun, refreshPrivate } from "../../lib/railgun.js";
import { publicConfig } from "../../lib/public-config.js";

export interface LogLine {
  ts: string;
  text: string;
  href?: string;
}

export interface ScanStats {
  frames: number;
  drops: number;
  fps: number;
}

export interface PayView {
  state: PayState;
  feedUrl: string | null;
  stats: ScanStats;
  log: LogLine[];
  evidence: EvidenceLine[];
  /** True while the mic is open (shown on screen: the user must always know). */
  micOn: boolean;
  /** World Agent Pass attempt in progress (url = fallback link if the window was blocked). */
  approval: { busy: boolean; url: string | null };
  /** "Pay privately" (Railgun) toggle: used when the private USDC balance covers the amount. */
  privateMode: boolean;
  /** This payment goes from the Railgun private balance (decided before policy). */
  privateSend: boolean;
  /** Seconds since sending started (PAYING), for the status line. */
  elapsedS: number;
  /** "Want to pay?" ask in progress. */
  ask: AskPhase;
}

/** Where the money goes: a scanned plain address, or a verified one-time address. Never anything else. */
const payTo = (r: Recipient): string => (r.kind === "address" ? r.address : r.kind === "private" ? r.destination : "");
const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}..${a.slice(-4)}` : a);
const stamp = () => new Date().toISOString().slice(11, 23);
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** A spoken reply that hasn't finished by then no longer holds up the queue (the mic waits for voices). */
const VOICE_MAX_MS = 25_000;
/** The "want to pay?" answer window (fixed, like the confirm window). */
export const ASK_LISTEN_MS = 5_000;

// "Asked once per glasses connection" must survive switching tabs, so the ask state lives here (one per tab), and
// a hub listener keeps its offline -> online edge up to date while the Pay tab isn't open.
let askMem: AskState = initialAsk;
let askWatching = false;
function reduceAsk(ev: AskEvent): AskState {
  askMem = askReducer(askMem, ev);
  return askMem;
}
function watchGlasses(hub: HubClient): void {
  if (askWatching) return;
  askWatching = true;
  hub.onStatus((s) => void reduceAsk({ t: "GLASSES", online: glassesUp(s) }));
}

export class PayController {
  private view: PayView = {
    state: initialPayState,
    feedUrl: null,
    stats: { frames: 0, drops: 0, fps: 0 },
    log: [],
    evidence: [],
    micOn: false,
    approval: { busy: false, url: null },
    privateMode: true,
    privateSend: false,
    elapsedS: 0,
    ask: "idle",
  };
  private listeners = new Set<() => void>();
  private gen = 0; // session generation: async results from an older session (or ask) are ignored
  private abort: AbortController | null = null;
  private offFrame: (() => void) | null = null;
  private offScanState: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private payTick: ReturnType<typeof setInterval> | null = null;
  private decoding = false;
  private frameTimes: number[] = [];
  private cameraOn = false;
  /** The Pay tab is open (attach() .. dispose()). The ask runs only then. */
  private attached = false;
  /** A session's closing voice is playing: no ask until it ends. */
  private ending = false;
  private askPending = false;
  /** Glasses were up at the last hub status (a drop is acted on once, at the edge). */
  private wasUp = false;
  /** Spoken replies play one at a time, in order. */
  private voiceQ: Promise<void> = Promise.resolve();
  /** Set only after a verified Agent Pass token for this session's exact payment. */
  private approvedFor: { to: string; amount: string; token: string } | null = null;
  /** Decided before policy: this payment goes from the Railgun private balance. */
  private sendPrivate = false;
  /** Native ETH delivered with a private payment to a one-time address (from shielded WETH; 0 for a plain address). */
  private privateGasDrop = 0n;

  /** Face match + quote + one-time pay (pay protocol v2): see private-flow.ts. */
  private readonly priv: PrivateFlow;

  constructor(
    private readonly hub: HubClient,
    private readonly getWallet: () => UnlockedWallet | null,
  ) {
    this.priv = new PrivateFlow({
      state: () => this.view.state,
      dispatch: (ev) => this.dispatch(ev),
      live: (g) => this.live(g),
      log: (t, href) => this.log(t, href),
      oled: (l) => this.oled(l),
      say: (t, p, l) => this.say(t, p, l),
      cameraOff: (why) => this.cameraOff(why),
      signal: () => this.abort?.signal,
      wallet: () => this.getWallet(),
      runAmount: (g) => this.guarded(g, () => this.runAmount(g)),
      runPolicy: (g) => this.guarded(g, () => this.runPolicy(g)),
    });
  }

  // ------------------------------------------------------------ store plumbing (useSyncExternalStore)
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getView = (): PayView => this.view;
  private set(p: Partial<PayView>): void {
    this.view = { ...this.view, ...p };
    this.listeners.forEach((f) => f());
  }
  private dispatch(ev: PayEvent): PayState {
    const next = payReducer(this.view.state, ev);
    if (next !== this.view.state) {
      this.set({ state: next });
      if (next.s === "CANCELLED" || next.s === "FAILED" || next.s === "BRAIN_OFFLINE") this.onEnd(next);
    }
    return next;
  }

  /** One scan-log line, also to the console. Never image data, transcripts or full addresses. */
  log(text: string, href?: string): void {
    const line = { ts: stamp(), text, href };
    console.info(`[cpay/pay] ${line.ts} ${text}`);
    this.set({ log: [...this.view.log.slice(-199), line] });
  }
  private addEvidence(lines: EvidenceLine[]): void {
    for (const e of lines) this.log(`0G ${e.kind}: request ${e.requestId ?? "(none)"} · receipt ${e.receipt}`);
    this.set({ evidence: [...this.view.evidence, ...lines] });
  }

  private oled(lines: string[]): void {
    try {
      // Never log the lines themselves: the confirm screen carries the one-time code, which belongs on the OLED only.
      if (!this.hub.setOled(lines)) this.log("OLED not sent (hub not connected)");
    } catch (e) {
      this.log(`OLED rejected: ${errText(e)}`);
    }
  }

  /**
   * Speak a fixed template; its text appears as a toast exactly when the audio starts (lib/voice-feedback.ts).
   * Voices are queued (never two at once). Resolves when this one has played (or was skipped / failed); never
   * rejects. A voice whose step is over by its turn is skipped (`stale`, default: the session moved on).
   * No ticket / TTS failure / playback blocked: the text shows at once + a "voice unavailable" error.
   */
  say(
    template: SpeakTemplate,
    params: Record<string, string | number> = {},
    link?: { href: string; label: string },
    opts: { stale?: () => boolean } = {},
  ): Promise<void> {
    const g = this.gen;
    const stale = opts.stale ?? (() => !this.live(g));
    const turn = async (): Promise<void> => {
      if (stale()) return this.log(`voice "${template}" skipped (moved on)`);
      try {
        const ticket = await this.hub.getTicket();
        const r = await withTimeout(sayWithToast(template, params, ticket, { link, live: () => this.live(g) }), VOICE_MAX_MS, `voice "${template}"`);
        this.addEvidence(r.evidence);
        this.log(r.played ? `voice "${template}" played` : `voice "${template}" unavailable (${r.why})`);
      } catch (e) {
        this.log(`voice "${template}" failed: ${errText(e)}`);
      }
    };
    const p = this.voiceQ.then(turn);
    this.voiceQ = p;
    return p;
  }

  setPrivateMode(on: boolean): void {
    if (!isActiveState(this.view.state)) this.set({ privateMode: on });
  }

  private live(g: number): boolean {
    return g === this.gen;
  }

  /** Runs one async step; anything it throws ends the session visibly (never an unhandled rejection). */
  private async guarded(g: number, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (!this.live(g) || isAbort(e)) return this.log(`step ended after stop: ${errText(e)}`);
      if (e instanceof BrainOffline) return this.brainOffline(g, e.message);
      this.log(`error: ${errText(e)}`);
      // Mid-send we can't know whether it went out: never claim "nothing was paid" then.
      const sending = this.view.state.s === "PAYING";
      this.dispatch({ t: "FAIL", reason: sending ? `Payment unconfirmed: ${errText(e)}` : errText(e), maybeSent: sending });
    }
  }

  // ------------------------------------------------------------ PAY TAB LIFECYCLE
  /** The Pay tab mounted. Returns the cleanup (React effect). */
  attach(): () => void {
    this.attached = true;
    watchGlasses(this.hub);
    this.offStatus = this.hub.onStatus((s) => this.onHubStatus(s)); // fires now with the current status
    return () => this.dispose();
  }

  private onHubStatus(s: HubStatus): void {
    const up = glassesUp(s);
    const dropped = this.wasUp && !up; // act once per drop, not on every status update while down
    this.wasUp = up;
    if (!up) {
      // view.ask, not askMem: the tab-wide watcher may already have reset askMem for this drop.
      if (this.view.ask !== "idle") this.cancelAsk("glasses disconnected");
      if (dropped && isActiveState(this.view.state)) this.glassesLost();
    }
    this.askEv({ t: "GLASSES", online: up }); // idempotent with watchGlasses()
    this.maybeAsk();
  }

  /** Wallet locked / unlocked while the Pay tab is open. */
  walletChanged(unlocked: boolean): void {
    if (unlocked) return this.maybeAsk();
    this.cancelAsk("wallet locked");
    if (isActiveState(this.view.state)) {
      this.log("wallet locked: session stopped");
      this.stop();
    }
  }

  /** Glasses dropped mid-session: camera + mic stop, nothing more is sent. A payment being sent still finishes. */
  private glassesLost(): void {
    if (this.view.state.s === "PAYING") {
      this.log("glasses disconnected while sending: the payment finishes on this phone");
      toast.warn("Glasses disconnected — the payment is still being sent from this phone");
      return;
    }
    this.log("glasses disconnected: session stopped, camera and mic off");
    this.abort?.abort();
    this.cameraOff("glasses disconnected");
    this.gen++;
    this.dispatch({ t: "STOP", reason: "Glasses disconnected" });
  }

  // ------------------------------------------------------------ WANT TO PAY? (hands-free start)
  private askEv(ev: AskEvent): void {
    reduceAsk(ev);
    if (this.view.ask !== askMem.phase) this.set({ ask: askMem.phase });
  }

  /**
   * Ask if one is owed and everything holds. Never on a timer: called on glasses / wallet / payment-end events.
   * Deferred one tick (React strict mode may detach + re-attach in the same tick; ask once things settle).
   */
  maybeAsk(): void {
    if (this.askPending) return;
    this.askPending = true;
    setTimeout(() => {
      this.askPending = false;
      this.tryAsk();
    }, 0);
  }

  private tryAsk(): void {
    const ok = shouldAsk(askMem, {
      enabled: askEnabled(),
      walletUnlocked: !!this.getWallet(),
      payTabOpen: this.attached,
      payIdle: !isActiveState(this.view.state) && !this.view.micOn && !this.ending && !this.cameraOn,
      glassesReady: glassesState(this.hub.status) === "paired",
    });
    if (ok) void this.runAsk();
  }

  /** Stop a running ask (mic off). An ask that is owed but not started stays owed. */
  private cancelAsk(why: string): void {
    if (askMem.phase === "idle" && this.view.ask === "idle") return;
    this.askEv({ t: "CANCEL" });
    this.log(`want-to-pay ask cancelled (${why})`);
    this.gen++;
    this.abort?.abort();
    this.set({ micOn: false });
  }

  private async runAsk(): Promise<void> {
    this.askEv({ t: "START" });
    if (askMem.phase !== "prompting") return;
    const g = ++this.gen;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const askLive = () => this.live(g) && askMem.phase !== "idle";
    const endAsk = (why: string, toastText: string) => {
      this.log(`want-to-pay ask ended: ${why}`);
      this.askEv({ t: "CANCEL" });
      this.oled(oledStates.ready());
      toast.warn(toastText);
    };
    try {
      unlockAudio();
      this.log('asking "want to pay?" (glasses online)');
      this.oled(oledStates.wantToPay());
      await this.say("wantToPay", {}, undefined, { stale: () => !askLive() });
      if (!askLive()) return;
      this.askEv({ t: "LISTEN" });
      beep();
      this.log(`mic on: yes / not now (${ASK_LISTEN_MS / 1000} s)`);
      let rec: Recording;
      try {
        this.set({ micOn: true });
        rec = await record({ mode: "fixed", ms: ASK_LISTEN_MS }, abort.signal);
      } catch (e) {
        if (askLive()) endAsk(micErrorText(e), `${micErrorText(e)}. Press Scan to pay.`);
        return;
      } finally {
        this.set({ micOn: false });
      }
      if (!askLive()) return;
      this.log(`mic off (${rec.ms} ms)`);
      this.askEv({ t: "RECORDED" });
      let text = "";
      if (rec.heardSpeech) {
        const ticket = await this.hub.getTicket();
        if (!askLive()) return;
        if (!ticket) return endAsk("no hub ticket", "Voice agent unreachable. Press Scan to pay.");
        const r = await transcribe(rec.blob, ticket, abort.signal);
        if (!askLive()) return;
        this.addEvidence(r.evidence);
        text = r.text;
      }
      // Deterministic check on the phone (never an LLM). The transcript is not logged.
      const answer = matchWantToPay(text);
      this.log(`want-to-pay check: ${answer}`);
      this.askEv({ t: "ANSWER" });
      if (answer === "yes") return this.startScan(true);
      this.oled(oledStates.ready());
      await this.say("notNow");
    } catch (e) {
      if (!askLive() || isAbort(e)) return;
      if (e instanceof BrainOffline) return endAsk(`voice agent offline (${e.message})`, "Voice agent (0G) unreachable. Press Scan to pay.");
      endAsk(errText(e), "Couldn't hear an answer. Press Scan to pay.");
    }
  }

  // ------------------------------------------------------------ SCAN
  /** Called from the Scan tap (a user gesture: unlocks audio on iOS), or a spoken "yes" to "want to pay?". */
  startScan(fromAsk = false): void {
    unlockAudio();
    const asking = this.view.ask !== "idle" || askMem.phase !== "idle";
    this.askEv({ t: "CANCEL" }); // a tap on Scan always wins over the ask
    if (asking) this.set({ micOn: false });
    if (!this.getWallet()) {
      toast.error("Unlock your wallet first");
      return this.log("Unlock your wallet first");
    }
    const g = ++this.gen;
    this.abort?.abort();
    this.abort = new AbortController();
    this.clearTimers();
    this.set({ stats: { frames: 0, drops: 0, fps: 0 }, privateSend: false, elapsedS: 0, ...(asking || fromAsk ? {} : { evidence: [] }) });
    this.frameTimes = [];
    this.priv.resetScan();
    this.approvedFor = null;
    this.sendPrivate = false;
    this.privateGasDrop = 0n;
    const st = this.dispatch({ t: "SCAN", now: Date.now() });
    if (st.s !== "SCANNING") return;
    if (!this.hub.scan(true)) {
      this.dispatch({ t: "FAIL", reason: "Glasses not connected" });
      return;
    }
    this.cameraOn = true;
    this.log("scan on (max 30 s)");
    this.oled(oledStates.scanning());
    void this.say("scanning", {}, undefined, { stale: () => !this.live(g) || this.view.state.s !== "SCANNING" });
    this.offFrame ??= this.hub.onFrame((f) => void this.onFrame(f));
    this.offScanState ??= this.hub.onScanState(({ on, reason }) => {
      if (!on && this.cameraOn) {
        this.cameraOn = false;
        this.clearFeed();
        this.log(`camera off (${reason})`);
      }
    });
    this.scanTimer = setTimeout(() => this.onScanTimeout(g), PAY_LIMITS.scanMs);
  }

  private cameraOff(why: string): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    if (this.cameraOn) {
      this.hub.scan(false);
      this.cameraOn = false;
      this.log(`scan off (${why})`);
    }
    this.clearFeed();
  }

  private clearFeed(): void {
    if (this.view.feedUrl) URL.revokeObjectURL(this.view.feedUrl);
    if (this.view.feedUrl !== null) this.set({ feedUrl: null });
  }

  private async onFrame(f: FrameMsg): Promise<void> {
    try {
      await this.handleFrame(f);
    } catch (e) {
      this.decoding = false;
      this.log(`frame error: ${errText(e)}`);
    }
  }

  private async handleFrame(f: FrameMsg): Promise<void> {
    if (!this.cameraOn) return;
    const now = performance.now();
    this.frameTimes = [...this.frameTimes.filter((t) => now - t < 1000), now];
    const stats = { ...this.view.stats, frames: this.view.stats.frames + 1, fps: this.frameTimes.length };
    const blob = frameBlob(f.dataBase64, f.mime);
    // Live feed: one object URL at a time.
    const old = this.view.feedUrl;
    this.set({ feedUrl: URL.createObjectURL(blob), stats });
    if (old) URL.revokeObjectURL(old);

    if (this.decoding) {
      this.set({ stats: { ...this.view.stats, drops: this.view.stats.drops + 1 } });
      return;
    }
    const s = this.view.state.s;
    if (s !== "SCANNING" && s !== "NO_QR") return;
    this.decoding = true;
    let text: string | null = null;
    try {
      text = await decodeQrFromJpeg(blob);
    } catch {
      this.set({ stats: { ...this.view.stats, drops: this.view.stats.drops + 1 } });
    } finally {
      this.decoding = false;
    }
    if (!text) {
      // No QR in this frame: look for a steady centred face (pay protocol v2). A QR seen first always wins.
      if (this.view.state.s === "SCANNING") this.priv.onFrame(this.gen, blob);
      return;
    }
    const cur = this.view.state.s;
    if (cur !== "SCANNING" && cur !== "NO_QR") return;

    let parsed;
    try {
      parsed = parseQr(text);
    } catch (e) {
      this.log(`QR parse error: ${errText(e)}`);
      return;
    }
    if (parsed.kind === "unsupported") {
      const why = unsupportedWhy(parsed);
      if (this.view.state.s === "SCANNING" && (this.view.state as { lastUnsupported: unknown }).lastUnsupported !== why) {
        this.log(`QR seen: ${why === "wrong_network" ? "wrong network" : "not a wallet QR"} (still scanning)`);
      }
      this.dispatch({ t: "QR_UNSUPPORTED", why });
      return;
    }
    const recipient: Recipient =
      parsed.kind === "cpay"
        ? { kind: "cpay", peerId: parsed.peerId, pub: parsed.pub, qrSecret: parsed.qrSecret }
        : { kind: "address", address: parsed.address, chainId: parsed.chainId, token: parsed.token, amount: parsed.amount };
    this.cameraOff("QR read");
    const next = this.dispatch({ t: "QR_FOUND", recipient });
    if (recipient.kind === "cpay") {
      this.log(`QR: CPay (private) · peer ${recipient.peerId.slice(0, 8)}`);
      this.oled(["CPAY QR", "SAY AMOUNT"]);
    } else {
      this.log(
        `QR: ${text.startsWith("ethereum:") ? "EIP-681" : "plain address"} · ${shortAddr(recipient.address)} · chain ${recipient.chainId ?? "default"}${recipient.amount ? ` · amount ${recipient.amount}` : ""}`,
      );
      this.oled(oledStates.publicAddr(recipient.address));
    }
    if (next.s !== "QR_LOCKED") return;
    // Voice first ("QR code found. Say the amount after the beep."), then the beep + mic (runAmount).
    const g = this.gen;
    void this.guarded(g, async () => {
      await this.say("qrFound");
      if (this.live(g)) await this.runAmount(g);
    });
  }

  private onScanTimeout(g: number): void {
    if (!this.live(g)) return;
    const st = this.dispatch({ t: "SCAN_TIMEOUT" });
    if (st.s !== "NO_QR") return;
    this.log(`no valid QR in ${PAY_LIMITS.scanMs / 1000} s (${st.why}); camera on ${PAY_LIMITS.reaimMs / 1000} s more to re-aim`);
    if (st.why === "wrong_network") {
      this.oled(oledStates.wrongNetwork());
      void this.say("wrongNetwork");
    } else if (st.why === "not_wallet") {
      this.oled(oledStates.notWalletQr());
      void this.say("notWalletQr");
    } else {
      this.oled(oledStates.noQr());
      void this.say("noQr");
    }
    this.graceTimer = setTimeout(() => {
      if (this.live(g) && this.view.state.s === "NO_QR") this.cameraOff("re-aim window over");
    }, PAY_LIMITS.reaimMs);
  }

  // ------------------------------------------------------------ AMOUNT
  /** Beep, then the mic (the beep is the one cue that the mic is open; it never opens while a voice plays). */
  private async listen(g: number, opts: Parameters<typeof record>[0], what: string): Promise<Recording | null> {
    beep();
    this.log(`mic on: ${what}`);
    try {
      this.set({ micOn: true });
      return await record(opts, this.abort?.signal);
    } catch (e) {
      if (this.live(g)) this.dispatch({ t: "FAIL", reason: micErrorText(e) });
      return null;
    } finally {
      this.set({ micOn: false });
    }
  }

  private async runAmount(g: number): Promise<void> {
    this.dispatch({ t: "AMOUNT_LISTEN" });
    while (this.live(g) && this.view.state.s === "LISTENING_AMOUNT") {
      const tries = (this.view.state as { tries: number }).tries;
      const rec = await this.listen(g, { mode: "vad" }, `say the amount (try ${tries}, until silence, max 8 s)`);
      if (!rec || !this.live(g)) return;
      this.log(`mic off (${rec.ms} ms, ${rec.verdict})`);
      this.dispatch({ t: "AMOUNT_RECORDED" });

      let result: Awaited<ReturnType<typeof intentFromAudio>>;
      if (!rec.heardSpeech) {
        this.log("no speech heard: not sent to 0G");
        result = { kind: "refusal", evidence: [] };
      } else {
        const ticket = await this.hub.getTicket();
        if (!this.live(g)) return;
        if (!ticket) return this.brainOffline(g, "no hub ticket (glasses hub unreachable)");
        try {
          result = await intentFromAudio(rec.blob, ticket, this.abort?.signal);
        } catch (e) {
          if (!this.live(g)) return;
          if (e instanceof BrainOffline) return this.brainOffline(g, e.message);
          throw e;
        }
        if (!this.live(g)) return;
        this.addEvidence(result.evidence);
      }

      if (result.kind === "intent") {
        this.log(`0G intent: ${result.amount} ${result.token}`);
        const st = this.dispatch({ t: "AMOUNT_HEARD", intent: { amount: result.amount, token: result.token } });
        if (st.s === "CANCELLED") return;
        await this.say("ack", { amount: result.amount, token: result.token });
        if (!this.live(g)) return;
        // CPay QR / face: fetch + verify the one-time address first (QUOTE), then policy.
        if ((this.view.state as PayState).s === "THINKING") return this.priv.runQuote(g);
        return this.runPolicy(g);
      }
      this.log("0G: no clear amount");
      const st = this.dispatch({ t: "AMOUNT_REFUSED" });
      if (st.s === "LISTENING_AMOUNT") {
        this.oled(oledStates.sayAmountAgain());
        await this.say("sayAmountAgain");
      }
    }
  }

  private brainOffline(g: number, detail: string): void {
    if (!this.live(g)) return;
    this.log(`BRAIN OFFLINE: ${detail}. Paused, nothing paid.`);
    this.dispatch({ t: "BRAIN_OFFLINE", detail });
  }

  // ------------------------------------------------------------ POLICY
  private async runPolicy(g: number): Promise<void> {
    const st = this.view.state;
    if (st.s !== "POLICY") return;
    const wallet = this.getWallet();
    if (!wallet) return void this.dispatch({ t: "FAIL", reason: "Wallet locked" });
    // Private (Railgun) when the toggle is on and the spendable private USDC covers it; else the agent wallet.
    const privateUsdc = await this.choosePrivate(wallet, st.intent.amount, st.intent.token, st.recipient);
    if (!this.live(g)) return;
    let res;
    try {
      // Reads the balance itself (or checks the private one); an unknown balance is a deny (fail closed).
      res = await evaluatePolicy({ wallet, amount: st.intent.amount, token: st.intent.token, recipient: st.recipient, privateUsdc });
    } catch (e) {
      if (!this.live(g)) return;
      return void this.dispatch({ t: "FAIL", reason: `Policy error: ${errText(e)}` });
    }
    if (!this.live(g)) return;
    this.log(`policy: ${res.decision}${res.reason ? ` (${res.reason})` : ""}`);
    const next = this.dispatch({ t: "POLICY", decision: res.decision, reason: res.reason });
    if (next.s === "NEEDS_APPROVAL") {
      this.oled(oledStates.approveOnPhone());
      void this.say("needApproval", { amount: next.intent.amount, token: next.intent.token });
      this.log("over a cap: tap “Approve with World” on the phone (World Agent Pass)");
      return; // approveWithWorld() (a tap) takes over
    }
    if (next.s === "POLICY") return this.runConfirm(g);
  }

  /** Sets sendPrivate; returns the private USDC balance policy must check, or undefined (agent wallet). */
  private async choosePrivate(wallet: UnlockedWallet, amount: string, token: string, recipient: Recipient): Promise<bigint | undefined> {
    this.sendPrivate = false;
    this.privateGasDrop = 0n;
    this.set({ privateSend: false });
    if (!this.view.privateMode) return undefined;
    const need = toBaseUnits(amount);
    if (token !== "USDC" || need === null) return undefined;
    // A one-time address also needs gas to move the funds: it comes from the shielded WETH, same UserOperation.
    const gasDropWei = recipient.kind === "private" ? publicConfig.gasDropWei : 0n;
    try {
      // Spendable (POI-valid) USDC incl. the 0.25% unshield fee, WETH for the paymaster fee (+ gas drop).
      const r = await withTimeout(canPayPrivately(wallet, need, gasDropWei), 10_000, "private balance check");
      this.log(`private balance: ${r.ok ? "covers it" : r.reason === "usdc" ? "USDC too low" : "WETH for fees too low"} (Railgun)`);
      if (r.ok) {
        this.sendPrivate = true;
        this.privateGasDrop = gasDropWei;
        this.set({ privateSend: true });
        return r.usdcValid;
      }
      toast.warn("Private payment unavailable — paying from agent wallet (visible)");
    } catch (e) {
      this.log(`private payments unavailable: ${errText(e)}`);
      toast.warn("Private payments unavailable — paying from agent wallet (visible)");
    }
    return undefined;
  }

  // ------------------------------------------------------------ AGENT PASS (over a cap)
  /**
   * Tap "Approve with World" (a user gesture, so the World window may open). Binding = exactly this
   * payment {fresh sessionId, amount (base units), token, to}; the signed token is verified on this phone
   * (signature, binding, linked World account, expiry, unused jti) before the flow continues to confirm.
   */
  approveWithWorld(): void {
    const st = this.view.state;
    // A plain address, or a verified one-time address (private recipients reach policy only after QUOTE).
    const to = st.s === "NEEDS_APPROVAL" ? payTo(st.recipient) : "";
    if (st.s !== "NEEDS_APPROVAL" || this.view.approval.busy || !to) return;
    const win = openApprovalWindow();
    const g = this.gen;
    void this.guarded(g, () => this.runApproval(g, st.intent, to, win));
  }

  private async runApproval(g: number, intent: { amount: string; token: string }, to: string, win: Window | null): Promise<void> {
    this.set({ approval: { busy: true, url: null } });
    try {
      const subHash = await linkedSubHash();
      if (!this.live(g)) return void win?.close();
      if (!subHash) {
        win?.close();
        this.dispatch({ t: "APPROVAL_RESULT", approved: false, reason: "World not linked: Settings → Link World" });
        return;
      }
      let binding: ApprovalBindingJson;
      try {
        binding = approvalBinding({ sessionId: crypto.randomUUID(), amount: intent.amount, token: intent.token, to });
      } catch (e) {
        win?.close();
        return void this.dispatch({ t: "FAIL", reason: errText(e) });
      }
      this.log("Agent Pass: waiting for approval in World");
      // Only the salted commitment leaves the phone; binding + salt stay here for the token check.
      const { salt, bindingCommit } = approvalCommit(binding);
      const r = await runAgentPass(
        { mode: "approve", bindingCommit, subHash },
        { win, signal: this.abort?.signal, onUrl: (url) => this.set({ approval: { busy: true, url } }) },
      );
      if (!this.live(g)) return;
      if (!r.approved || r.mode !== "approve") {
        const reason = r.approved ? "unexpected result" : r.reason;
        this.log(`Agent Pass: not approved (${reason})`);
        return void this.dispatch({ t: "APPROVAL_RESULT", approved: false, reason });
      }
      const bad = await verifyApproval(r.token, binding, salt, subHash);
      if (!this.live(g)) return;
      if (bad) {
        this.log(`Agent Pass: token rejected on this phone (${bad})`);
        return void this.dispatch({ t: "APPROVAL_RESULT", approved: false, reason: `token ${bad}` });
      }
      this.approvedFor = { to: binding.to.toLowerCase(), amount: intent.amount, token: intent.token };
      this.log("Agent Pass: approved · token verified on this phone (single use)");
      const next = this.dispatch({ t: "APPROVAL_RESULT", approved: true });
      if (next.s === "POLICY") await this.runConfirm(g);
    } finally {
      this.set({ approval: { busy: false, url: null } });
    }
  }

  // ------------------------------------------------------------ CONFIRM
  private async runConfirm(g: number): Promise<void> {
    const st0 = this.view.state;
    if (st0.s !== "POLICY") return;
    const code = newConfirmCode();
    this.dispatch({ t: "CONFIRM_START", code, now: Date.now() });
    this.tick = setInterval(() => {
      if (this.live(g)) this.dispatch({ t: "TICK", now: Date.now() });
    }, 500);
    const { amount, token } = st0.intent;
    const to = payTo(st0.recipient);
    this.log("confirm: one-time code shown on the glasses only");
    // The wearer hears and sees whether this payment is private or public before confirming.
    const downgraded = this.view.privateMode && !this.sendPrivate;
    this.oled(oledStates.confirm(amount, token, code, this.sendPrivate ? "private" : "public"));
    if (downgraded) this.log("Pay privately is on, but this payment would be PUBLIC (from the agent wallet)");
    await this.say(downgraded ? "confirmPromptPublic" : "confirmPrompt", { amount, token }); // code is OLED-only, never spoken by TTS

    while (this.live(g) && this.view.state.s === "CONFIRMING") {
      const c = this.view.state;
      if (c.phase === "tap") {
        this.oled(["CONFIRM ON PHONE"]);
        this.log("two unclear tries: tap Confirm on the phone (or Stop)");
        return; // the tap handler takes over
      }
      const rec = await this.listen(g, { mode: "fixed", ms: 5_000 }, `confirm window 5 s (try ${c.voiceTries})`);
      if (!rec || !this.live(g) || this.view.state.s !== "CONFIRMING") return;
      this.log("mic off");
      this.dispatch({ t: "CONFIRM_RECORDED" });
      let text = "";
      if (rec.heardSpeech) {
        const ticket = await this.hub.getTicket();
        if (!this.live(g)) return;
        if (!ticket) return this.brainOffline(g, "no hub ticket");
        try {
          const r = await transcribe(rec.blob, ticket, this.abort?.signal);
          text = r.text;
          this.addEvidence(r.evidence);
        } catch (e) {
          if (!this.live(g)) return;
          if (e instanceof BrainOffline) return this.brainOffline(g, e.message);
          throw e;
        }
      }
      if (!this.live(g) || this.view.state.s !== "CONFIRMING") return;
      // Deterministic check on the phone (never an LLM). The transcript is not logged.
      const match = matchConfirm(text, code);
      this.log(`confirm check: ${match}`);
      const next = this.dispatch({ t: "CONFIRM_RESULT", match });
      if (next.s === "CONFIRMING" && next.phase === "listening") {
        this.oled(oledStates.confirmAgain(code));
        await this.say("confirmAgain");
      }
    }
    if (this.live(g) && this.view.state.s === "PAYING") await this.runPay(g, to, amount, token);
  }

  /** Tap fallback after two unclear voice tries. */
  confirmTap(): void {
    const g = this.gen;
    const st = this.view.state;
    if (st.s !== "CONFIRMING" || st.phase !== "tap") return;
    const next = this.dispatch({ t: "CONFIRM_TAP" });
    const to = payTo(st.recipient);
    if (next.s === "PAYING" && to) {
      this.log("confirmed by tap");
      void this.guarded(g, () => this.runPay(g, to, st.intent.amount, st.intent.token));
    }
  }

  // ------------------------------------------------------------ PAY
  /** PAYING: elapsed seconds for the status line. Cleared with the other timers. */
  private startPayClock(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.payTick) clearInterval(this.payTick);
    const t0 = Date.now();
    this.set({ elapsedS: 0 });
    this.payTick = setInterval(() => this.set({ elapsedS: Math.floor((Date.now() - t0) / 1000) }), 1_000);
  }

  /** A payment went out: report it (even after Stop), then the closing voice, then maybe ask again. */
  private onPaid(hash: string, amount: string, token: string, note = ""): Promise<void> {
    this.clearTimers();
    this.dispatch({ t: "PAID", txHash: hash });
    this.log(`tx ${hash.slice(0, 10)}…${note}`, txUrl(hash));
    return recordSpend(amount, hash)
      .catch((e: unknown) => this.log(`ledger update failed: ${errText(e)}`))
      .then(() => {
        this.oled(oledStates.paid(amount, token));
        const g = this.gen;
        void this.closing(g, this.say("paid", { amount, token }, { href: txUrl(hash), label: "View tx" }), true);
      });
  }

  private async runPay(g: number, to: string, amount: string, token: string): Promise<void> {
    this.startPayClock();
    const wallet = this.getWallet();
    if (!wallet || !to) return void this.dispatch({ t: "FAIL", reason: "Wallet locked" });
    // Belt and braces: an over-cap payment must be exactly the one World approved.
    const a = this.approvedFor;
    if (a && (a.to !== to.toLowerCase() || a.amount !== amount || a.token !== token)) {
      return void this.dispatch({ t: "FAIL", reason: "Payment differs from the approved one" });
    }
    if (this.sendPrivate) return this.runPrivatePay(wallet, to, amount, token);
    const cur = this.view.state;
    if (cur.s === "PAYING" && cur.recipient.kind === "private") return this.priv.pay(g, to, amount, token);
    this.oled(oledStates.paying());
    this.log(`paying ${amount} ${token} to ${shortAddr(to)} (signed on this phone)`);
    let hash: string;
    try {
      hash = await payDirect(wallet, { to, amount, token });
    } catch (e) {
      // Sent once, never retried automatically. If it may be on-chain, say "unconfirmed", not "nothing paid".
      const f = sendFailure(e);
      this.dispatch({ t: "FAIL", reason: f.reason, maybeSent: f.maybeSent });
      return;
    }
    await this.onPaid(hash, amount, token);
  }

  /**
   * Pay from the Railgun private balance: proof made on this phone, sent via the bundler. Once started there is
   * NO fallback to the agent wallet (never re-pay publicly); a failure is a visible FAIL.
   */
  private async runPrivatePay(wallet: UnlockedWallet, to: string, amount: string, token: string): Promise<void> {
    const base = toBaseUnits(amount);
    if (base === null || !/^0x[0-9a-fA-F]{40}$/.test(to)) return void this.dispatch({ t: "FAIL", reason: "Invalid payment" });
    this.oled(oledStates.paying("private"));
    const gasDropWei = this.privateGasDrop;
    this.log(
      `paying ${amount} ${token}${gasDropWei > 0n ? " + gas" : ""} privately (Railgun) to ${shortAddr(to)} · proof made on this phone`,
    );
    void this.say("sendingPrivately", {}, undefined, { stale: () => this.view.state.s !== "PAYING" });
    let hash: `0x${string}`;
    let stage: string | undefined;
    try {
      const client = await getRailgun(wallet);
      const r = await client.pay({
        amount: base,
        to: to as `0x${string}`,
        gasDropWei,
        onStage: (s) => {
          stage = s;
          this.log(`private pay: ${s}`);
        },
      });
      hash = r.txHash;
    } catch (e) {
      const f = sendFailure(e, stage);
      this.dispatch({ t: "FAIL", reason: f.maybeSent ? f.reason : `Private payment failed: ${errText(e)}`, maybeSent: f.maybeSent });
      return;
    }
    await this.onPaid(hash, amount, token, " (private)");
    void refreshPrivate(wallet).catch(() => undefined);
  }

  // ------------------------------------------------------------ STOP / END
  stop(): void {
    if (this.view.ask !== "idle") {
      this.cancelAsk("Stop tapped");
      this.oled(oledStates.ready());
    }
    this.abort?.abort();
    this.cameraOff("stopped");
    // A payment being sent can't be recalled: let it finish and report.
    const s = this.view.state.s;
    if (s !== "PAID" && s !== "PAYING") {
      this.gen++;
      this.dispatch({ t: "STOP" });
    }
  }

  private onEnd(st: PayState): void {
    this.clearTimers();
    this.abort?.abort(); // e.g. confirm timed out while the mic was open: close it now
    this.cameraOff("session ended");
    const g = this.gen;
    if (st.s === "BRAIN_OFFLINE") {
      this.oled(oledStates.brainOffline());
      void this.say("brainOffline");
      return;
    }
    if (st.s === "FAILED") {
      this.log(`failed: ${st.reason}`);
      if (st.maybeSent) {
        // Never "payFailed" here (it says "nothing was paid"): the payment may have gone out. No re-ask afterwards.
        this.oled(oledStates.payUnconfirmed());
        void this.say("payUnconfirmed").then(() => void toast.error("Payment unconfirmed — check the transaction log before paying again"));
        return;
      }
      // Glasses + voice say it failed; the phone keeps the exact reason (status line + toast after the voice).
      this.oled(oledStates.failed());
      void this.closing(g, this.say("payFailed").then(() => void toast.error(st.reason)), true);
      return;
    }
    if (st.s !== "CANCELLED") return;
    this.log(`cancelled: ${st.reason}`);
    this.oled(oledStates.cancelled());
    if (st.reason === "Glasses disconnected") {
      void this.say("cancelled").then(() => void toast.warn("Glasses disconnected — nothing was paid"));
      return; // asked again when the glasses come back
    }
    // Why it was denied follows the spoken "denied" (e.g. which cap, or "World not linked").
    const spoken =
      st.reason.startsWith("Policy") || st.reason.startsWith("Approval")
        ? this.say("denied").then(() => void toast.warn(st.reason))
        : this.say("cancelled");
    // A Stop tap is the wearer at the phone saying "not now": no ask straight after it.
    void this.closing(g, spoken, st.reason !== "Stopped");
  }

  /** Wait for the closing voice; then (same session, nothing new started) the "want to pay?" ask is owed again. */
  private async closing(g: number, spoken: Promise<void>, askAgain: boolean): Promise<void> {
    this.ending = true;
    try {
      await spoken;
    } finally {
      this.ending = false;
    }
    if (!askAgain || !this.live(g)) return;
    this.askEv({ t: "PAYMENT_ENDED" });
    this.maybeAsk();
  }

  private clearTimers(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.payTick) clearInterval(this.payTick);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.tick = this.payTick = this.scanTimer = this.graceTimer = null;
  }

  dispose(): void {
    this.attached = false;
    this.offStatus?.();
    this.offStatus = null;
    this.cancelAsk("Pay tab closed");
    this.stop();
    this.offFrame?.();
    this.offScanState?.();
    this.offFrame = this.offScanState = null;
  }
}
