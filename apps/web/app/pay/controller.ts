"use client";
// Drives one /pay session: performs the I/O for each step of lib/pay-machine.ts and feeds results back.
// Order is fixed (invariant 7): QR destination -> 0G amount -> policy -> spoken confirm code -> sign on phone.
import { oledStates } from "@cpay/glasses-kit/hub";
import type { HubClient, FrameMsg } from "../../lib/hub-client.js";
import { initialPayState, isActive as isActiveState, payReducer, type PayEvent, type PayState, type Recipient } from "../../lib/pay-machine.js";
import { decodeQrFromJpeg, frameBlob } from "../../lib/frame-qr.js";
import { beep, record, unlockAudio } from "../../lib/voice-io.js";
import { sayWithToast } from "../../lib/voice-feedback.js";
import { toast } from "../../lib/toast.js";
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
}

/** Where the money goes: a scanned plain address, or a verified one-time address. Never anything else. */
const payTo = (r: Recipient): string => (r.kind === "address" ? r.address : r.kind === "private" ? r.destination : "");
const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}..${a.slice(-4)}` : a);
const stamp = () => new Date().toISOString().slice(11, 23);

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
  };
  private listeners = new Set<() => void>();
  private gen = 0; // session generation: async results from an older session are ignored
  private abort: AbortController | null = null;
  private offFrame: (() => void) | null = null;
  private offScanState: (() => void) | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private decoding = false;
  private frameTimes: number[] = [];
  private cameraOn = false;
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
      runAmount: (g) => this.runAmount(g),
      runPolicy: (g) => this.runPolicy(g),
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
      if (!this.hub.setOled(lines)) this.log(`OLED not sent (hub not connected): ${lines.join(" / ")}`);
    } catch (e) {
      this.log(`OLED rejected: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Speak a fixed template; its text appears as a toast exactly when the audio starts (lib/voice-feedback.ts).
   * Resolves when playback ends. No ticket / TTS failure: the text shows at once + a "voice unavailable" error.
   */
  async say(template: SpeakTemplate, params: Record<string, string | number> = {}, link?: { href: string; label: string }): Promise<void> {
    const g = this.gen;
    const ticket = await this.hub.getTicket();
    const r = await sayWithToast(template, params, ticket, { link, live: () => this.live(g) });
    this.addEvidence(r.evidence);
    this.log(r.played ? `voice "${template}" played` : `voice "${template}" unavailable (${r.why})`);
  }

  setPrivateMode(on: boolean): void {
    if (!isActiveState(this.view.state)) this.set({ privateMode: on });
  }

  private live(g: number): boolean {
    return g === this.gen;
  }

  // ------------------------------------------------------------ SCAN
  /** Called from the Scan tap (a user gesture: unlocks audio on iOS). */
  startScan(): void {
    unlockAudio();
    if (!this.getWallet()) {
      toast.error("Unlock your wallet first");
      return this.log("Unlock your wallet first");
    }
    const g = ++this.gen;
    this.abort?.abort();
    this.abort = new AbortController();
    this.clearTimers();
    this.set({ stats: { frames: 0, drops: 0, fps: 0 }, evidence: [] });
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
    this.set({ feedUrl: null });
  }

  private async onFrame(f: FrameMsg): Promise<void> {
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
      this.log(`QR parse error: ${e instanceof Error ? e.message : String(e)}`);
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
    beep();
    const next = this.dispatch({ t: "QR_FOUND", recipient });
    if (recipient.kind === "cpay") {
      this.log(`QR: CPay (private) · peer ${recipient.peerId.slice(0, 8)}`);
      this.oled(["CPAY QR", "SAY AMOUNT"]);
      if (next.s === "QR_LOCKED") void this.runAmount(this.gen);
      return;
    }
    this.log(
      `QR: ${text.startsWith("ethereum:") ? "EIP-681" : "plain address"} · ${shortAddr(recipient.address)} · chain ${recipient.chainId ?? "default"}${recipient.amount ? ` · amount ${recipient.amount}` : ""}`,
    );
    this.oled(oledStates.publicAddr(recipient.address));
    if (next.s === "QR_LOCKED") void this.runAmount(this.gen);
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
  private async runAmount(g: number): Promise<void> {
    this.dispatch({ t: "AMOUNT_LISTEN" });
    while (this.live(g) && this.view.state.s === "LISTENING_AMOUNT") {
      const tries = (this.view.state as { tries: number }).tries;
      this.log(`mic on: say the amount (try ${tries}, until silence, max 8 s)`);
      let rec;
      try {
        this.set({ micOn: true });
        rec = await record({ mode: "vad" }, this.abort?.signal);
      } catch (e) {
        if (this.live(g)) this.dispatch({ t: "FAIL", reason: `Microphone: ${e instanceof Error ? e.message : String(e)}` });
        return;
      } finally {
        this.set({ micOn: false });
      }
      if (!this.live(g)) return;
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
          result = await intentFromAudio(rec.blob, ticket);
        } catch (e) {
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
      return void this.dispatch({ t: "FAIL", reason: `Policy error: ${e instanceof Error ? e.message : String(e)}` });
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
    if (!this.view.privateMode) return undefined;
    const need = toBaseUnits(amount);
    if (token !== "USDC" || need === null) return undefined;
    // A one-time address also needs gas to move the funds: it comes from the shielded WETH, same UserOperation.
    const gasDropWei = recipient.kind === "private" ? publicConfig.gasDropWei : 0n;
    try {
      // Spendable (POI-valid) USDC incl. the 0.25% unshield fee, WETH for the paymaster fee (+ gas drop).
      const r = await withTimeout(canPayPrivately(wallet, need, gasDropWei), 10_000);
      this.log(`private balance: ${r.ok ? "covers it" : r.reason === "usdc" ? "USDC too low" : "WETH for fees too low"} (Railgun)`);
      if (r.ok) {
        this.sendPrivate = true;
        this.privateGasDrop = gasDropWei;
        return r.usdcValid;
      }
      toast.warn("Not enough private balance — paying from agent wallet (visible)");
    } catch (e) {
      this.log(`private payments unavailable: ${e instanceof Error ? e.message : String(e)}`);
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
    void this.runApproval(this.gen, st.intent, to, win);
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
        return void this.dispatch({ t: "FAIL", reason: e instanceof Error ? e.message : String(e) });
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
      this.log(`mic on: confirm window 5 s (try ${c.voiceTries})`);
      let rec;
      try {
        this.set({ micOn: true });
        rec = await record({ mode: "fixed", ms: 5_000 }, this.abort?.signal);
      } catch (e) {
        if (this.live(g)) this.dispatch({ t: "FAIL", reason: `Microphone: ${e instanceof Error ? e.message : String(e)}` });
        return;
      } finally {
        this.set({ micOn: false });
      }
      if (!this.live(g) || this.view.state.s !== "CONFIRMING") return;
      this.log("mic off");
      this.dispatch({ t: "CONFIRM_RECORDED" });
      let text = "";
      if (rec.heardSpeech) {
        const ticket = await this.hub.getTicket();
        if (!this.live(g)) return;
        if (!ticket) return this.brainOffline(g, "no hub ticket");
        try {
          const r = await transcribe(rec.blob, ticket);
          text = r.text;
          this.addEvidence(r.evidence);
        } catch (e) {
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
      void this.runPay(g, to, st.intent.amount, st.intent.token);
    }
  }

  // ------------------------------------------------------------ PAY
  private async runPay(g: number, to: string, amount: string, token: string): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
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
      this.dispatch({ t: "FAIL", reason: `Payment failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    void g;
    // A sent payment is always reported, even if the user pressed Stop meanwhile.
    this.dispatch({ t: "PAID", txHash: hash });
    this.log(`tx ${hash.slice(0, 10)}…`, txUrl(hash));
    try {
      await recordSpend(amount, hash);
    } catch (e) {
      this.log(`ledger update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.oled(oledStates.paid(amount, token));
    void this.say("paid", { amount, token }, { href: txUrl(hash), label: "View tx" });
  }

  /**
   * Pay from the Railgun private balance: proof made on this phone, sent via the bundler. Once started there is
   * NO fallback to the agent wallet (never re-pay publicly); a failure is a visible FAIL.
   */
  private async runPrivatePay(wallet: UnlockedWallet, to: string, amount: string, token: string): Promise<void> {
    const base = toBaseUnits(amount);
    if (base === null || !/^0x[0-9a-fA-F]{40}$/.test(to)) return void this.dispatch({ t: "FAIL", reason: "Invalid payment" });
    this.oled(oledStates.paying());
    const gasDropWei = this.privateGasDrop;
    this.log(
      `paying ${amount} ${token}${gasDropWei > 0n ? " + gas" : ""} privately (Railgun) to ${shortAddr(to)} · proof made on this phone`,
    );
    const spoken = this.say("sendingPrivately");
    let hash: `0x${string}`;
    try {
      const client = await getRailgun(wallet);
      const r = await client.pay({ amount: base, to: to as `0x${string}`, gasDropWei, onStage: (s) => this.log(`private pay: ${s}`) });
      hash = r.txHash;
    } catch (e) {
      this.dispatch({ t: "FAIL", reason: `Private payment failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    // A sent payment is always reported, even if the user pressed Stop meanwhile.
    this.dispatch({ t: "PAID", txHash: hash });
    this.log(`tx ${hash.slice(0, 10)}… (private)`, txUrl(hash));
    try {
      await recordSpend(amount, hash);
    } catch (e) {
      this.log(`ledger update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.oled(oledStates.paid(amount, token));
    await spoken;
    void this.say("paid", { amount, token }, { href: txUrl(hash), label: "View tx" });
    void refreshPrivate(wallet).catch(() => undefined);
  }

  // ------------------------------------------------------------ STOP / END
  stop(): void {
    this.abort?.abort();
    this.cameraOff("stopped");
    // A payment being sent can't be recalled: let it finish and report.
    const s = this.view.state.s;
    if (s !== "PAID" && s !== "PAYING") {
      this.gen++;
      this.dispatch({ t: "STOP" });
    }
  }

  reset(): void {
    if (this.view.state.s === "PAYING") return;
    this.stop();
    this.gen++;
    this.dispatch({ t: "RESET" });
    this.oled(oledStates.ready());
  }

  private onEnd(st: PayState): void {
    this.clearTimers();
    this.cameraOff("session ended");
    if (st.s === "BRAIN_OFFLINE") {
      this.oled(oledStates.brainOffline());
      void this.say("brainOffline");
    } else if (st.s === "CANCELLED" || st.s === "FAILED") {
      this.log(`${st.s === "CANCELLED" ? "cancelled" : "failed"}: ${st.reason}`);
      // The reason has no voice template: show it now (errors stay until tapped).
      if (st.s === "FAILED") toast.error(st.reason);
      this.oled(oledStates.cancelled());
      // Why it was denied follows the spoken "denied" (e.g. which cap, or "World not linked").
      if (st.s === "CANCELLED" && (st.reason.startsWith("Policy") || st.reason.startsWith("Approval")))
        void this.say("denied").then(() => toast.warn(st.reason));
      else void this.say("cancelled");
    }
  }

  private clearTimers(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.tick = this.scanTimer = this.graceTimer = null;
  }

  dispose(): void {
    this.stop();
    this.offFrame?.();
    this.offScanState?.();
    this.offFrame = this.offScanState = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });
}
