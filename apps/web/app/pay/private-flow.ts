"use client";
// Private recipients for /pay (pay protocol v2, docs/ARCHITECTURE.md "Face path"). Kept apart from controller.ts
// so the plain-QR flow stays readable; the controller calls in at four points (frame, after amount, pay, scan start).
//
//   FACE   steady centred face on the glasses frame -> embed ON THIS PHONE -> camera off -> sealed probe to every
//          other online phone -> exactly one "match" in PAY2_LIMITS.matchWaitMs -> amount step
//   QUOTE  (face, or a scanned CPay QR) sealed quote {chain, token, amount[, matchSecret]} to that one phone ->
//          claim within PAY2_LIMITS.claimWaitMs -> verifyClaim2 (proof bound to bindingDigest) -> POLICY
//   PAY    USDC + gas drop to the verified one-time address, signed on this phone
//
// The frame and the embedding are dropped (zeroed) right after the probe is built; nothing about them is logged.
import { oledStates } from "@cpay/glasses-kit/hub";
import {
  PAY2_LIMITS,
  buildFaceProbe,
  buildQuote,
  openClaim2,
  resolveMatches,
  type Claim2Body,
  type ClaimDelivery,
  type QuoteSession,
  type RoundSession,
} from "@cpay/protocol";
import { detectFaces, embedAligned } from "../../lib/face/engine.js";
import { pickFace } from "../../lib/face/geometry.js";
import { faceGateInit, faceGateStep, type FaceGateState, type FaceVerdict } from "../../lib/face/stability.js";
import { fetchIssuerPublicKey } from "../../lib/issuer-client.js";
import { needsQuote, type PayEvent, type PayState } from "../../lib/pay-machine.js";
import { RelayUnavailable, runRound } from "../../lib/pay2-payer.js";
import { publicConfig } from "../../lib/public-config.js";
import { getRecipient } from "../../lib/recipient-service.js";
import { beep } from "../../lib/voice-io.js";
import {
  NotConnectedError,
  chain,
  payFromRailgun,
  recordSpend,
  toBaseUnits,
  txUrl,
  verifyClaim2,
  type UnlockedWallet,
} from "../../lib/wallet.js";
import type { SpeakTemplate } from "../../lib/zg-client.js";

/** What the controller lends this flow. All callbacks are bound to the controller's current session. */
export interface PayHost {
  state(): PayState;
  dispatch(ev: PayEvent): PayState;
  live(g: number): boolean;
  log(text: string, href?: string): void;
  oled(lines: string[]): void;
  say(template: SpeakTemplate, params?: Record<string, string | number>): Promise<void>;
  cameraOff(why: string): void;
  signal(): AbortSignal | undefined;
  wallet(): UnlockedWallet | null;
  runAmount(g: number): Promise<void>;
  runPolicy(g: number): Promise<void>;
}

const aborted = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PrivateFlow {
  private faceBusy = false;
  private gate: FaceGateState = faceGateInit;
  private lastVerdict: FaceVerdict | null = null;
  private faceOff = false;

  constructor(private readonly h: PayHost) {}

  /** New scan: forget the previous face track. */
  resetScan(): void {
    this.gate = faceGateInit;
    this.lastVerdict = null;
    this.faceOff = false;
  }

  // ------------------------------------------------------------ FACE (round 1)
  /** Called for frames where no QR was found. Drops the frame if the face engine is still busy. */
  onFrame(g: number, frame: Blob): void {
    if (this.faceBusy || this.faceOff || this.h.state().s !== "SCANNING") return;
    if (!publicConfig.relayUrl) {
      this.faceOff = true;
      this.h.log("face pay: relay not connected (NEXT_PUBLIC_RELAY_URL unset); QR only");
      return;
    }
    this.faceBusy = true;
    void this.analyse(g, frame).finally(() => {
      this.faceBusy = false;
    });
  }

  private async analyse(g: number, frame: Blob): Promise<void> {
    let bmp: ImageBitmap | null = null;
    let embedding: Float32Array | null = null;
    try {
      bmp = await createImageBitmap(frame);
      const faces = await detectFaces(bmp, bmp.width, bmp.height);
      const picked = pickFace(faces, "centre", bmp.width, bmp.height);
      const [next, verdict] = faceGateStep(this.gate, faces, picked, bmp.width, bmp.height);
      this.gate = next;
      if (verdict !== this.lastVerdict && verdict !== "none") this.h.log(`face: ${verdict.replace("_", " ")}`);
      this.lastVerdict = verdict;
      // A QR read meanwhile wins: only go on while still scanning.
      if (verdict !== "stable" || !picked || !this.h.live(g) || this.h.state().s !== "SCANNING") return;
      embedding = await embedAligned(bmp, bmp.width, bmp.height, picked);
      bmp.close();
      bmp = null;
      if (!this.h.live(g) || this.h.state().s !== "SCANNING") return;
      await this.match(g, embedding);
    } catch (e) {
      if (!this.faceOff) {
        this.faceOff = true;
        this.h.log(`face model not connected (${errText(e)}); QR only for this scan`);
      }
    } finally {
      embedding?.fill(0);
      bmp?.close();
    }
  }

  private async match(g: number, embedding: Float32Array): Promise<void> {
    this.h.cameraOff("face locked");
    beep();
    this.h.dispatch({ t: "FACE_PROBED", now: Date.now() });
    this.h.oled(["MATCHING..."]);
    const box: { round: RoundSession | null } = { round: null };
    let res;
    try {
      res = await runRound(
        (peers) => {
          if (peers.length === 0) return null;
          const built = buildFaceProbe(peers, embedding);
          box.round = built.round;
          return built.message;
        },
        { exclude: getRecipient().self(), waitMs: PAY2_LIMITS.matchWaitMs, signal: this.h.signal() },
      );
    } catch (e) {
      if (aborted(e) || !this.h.live(g)) return;
      this.h.dispatch({ t: "FAIL", reason: e instanceof RelayUnavailable ? `Relay not connected: ${e.message}` : errText(e) });
      return;
    } finally {
      // The picture is gone already; drop the embedding now that it is sealed (or never sent).
      embedding.fill(0);
    }
    if (!this.h.live(g)) return;
    const round = box.round;
    if (!res.sent || !round) {
      this.h.log("face probe: no other CPay phones online");
      this.noMatch(g);
      return;
    }
    const r = resolveMatches(round, res.claims);
    this.h.log(`face probe: sent sealed to ${res.peerCount} phone(s) · ${res.claims.length} answer(s) in ${PAY2_LIMITS.matchWaitMs / 1000} s`);
    if (r.ok) {
      const st = this.h.dispatch({ t: "MATCH_RESULT", result: { ok: true, peerId: r.peer.peerId, pub: r.peer.pub, matchSecret: r.matchSecret } });
      if (st.s !== "QR_LOCKED") return;
      this.h.log("face: MATCHED one phone");
      this.h.oled(["MATCHED", "SAY AMOUNT"]);
      beep();
      void this.h.runAmount(g);
      return;
    }
    if (r.reason === "multiple") {
      this.h.log(`face: ${r.count} phones matched: aborted (never guess)`);
      this.h.dispatch({ t: "MATCH_RESULT", result: r });
      return;
    }
    this.noMatch(g);
  }

  private noMatch(g: number): void {
    if (!this.h.live(g)) return;
    this.h.dispatch({ t: "MATCH_RESULT", result: { ok: false, reason: "none", count: 0 } });
    this.h.oled(["NO MATCH", "TAP TO RETRY"]);
  }

  // ------------------------------------------------------------ QUOTE (round 2)
  /** After the amount: fetch + verify a fresh one-time address for a face match or a scanned CPay QR. */
  async runQuote(g: number): Promise<void> {
    const st0 = this.h.state();
    if (st0.s !== "THINKING" || !st0.intent || !needsQuote(st0.recipient)) return;
    const { recipient, intent } = st0;
    const amount = toBaseUnits(intent.amount);
    if (amount === null) return void this.h.dispatch({ t: "FAIL", reason: "Invalid amount" });
    let cfg;
    try {
      cfg = chain();
    } catch (e) {
      return void this.h.dispatch({ t: "FAIL", reason: `Chain not configured: ${errText(e)}` });
    }
    this.h.dispatch({ t: "QUOTE_START", now: Date.now() });
    this.h.oled(["VERIFYING", "RECIPIENT..."]);
    this.h.log(`quote: asking the ${recipient.kind === "face" ? "matched" : "CPay QR"} phone for a one-time address + proof`);

    const qbox: { round: QuoteSession | null } = { round: null };
    let res;
    try {
      res = await runRound(
        (peers) => {
          // Only the one phone, and only if it's still online with the same key.
          if (!peers.some((p) => p.peerId === recipient.peerId && p.pub === recipient.pub)) return null;
          const q = buildQuote({
            peer: { peerId: recipient.peerId, pub: recipient.pub },
            chainId: cfg.chainId,
            token: cfg.usdc,
            amount,
            ...(recipient.kind === "face" ? { matchSecret: recipient.matchSecret } : {}),
          });
          qbox.round = q.round;
          return q.message;
        },
        {
          exclude: getRecipient().self(),
          waitMs: PAY2_LIMITS.claimWaitMs,
          done: (cs) => { const r = qbox.round; return r !== null && cs.some((c) => openClaim2(r, c) !== null); },
          signal: this.h.signal(),
        },
      );
    } catch (e) {
      if (aborted(e) || !this.h.live(g)) return;
      return this.noVerified(g, e instanceof RelayUnavailable ? `relay not connected (${e.message})` : errText(e));
    }
    if (!this.h.live(g)) return;
    const round = qbox.round;
    if (!res.sent || !round) return this.noVerified(g, "recipient phone is offline");
    const claim = firstClaim(round, res.claims);
    if (!claim) return this.noVerified(g, `no claim in ${PAY2_LIMITS.claimWaitMs / 1000} s`);

    let verdict;
    try {
      const issuerPublicKey = await fetchIssuerPublicKey(publicConfig.issuerUrl);
      verdict = await verifyClaim2({ round, claim, issuerPublicKey });
    } catch (e) {
      if (!this.h.live(g)) return;
      if (e instanceof NotConnectedError) return void this.h.dispatch({ t: "FAIL", reason: `Not connected: ${e.message}` });
      return this.noVerified(g, `could not verify (${errText(e)})`);
    }
    if (!this.h.live(g)) return;
    if (!verdict.ok) return this.noVerified(g, `proof check failed: ${verdict.reason}`);
    if (verdict.tier !== publicConfig.requiredTier) return this.noVerified(g, `World ID tier "${verdict.tier}" is not "${publicConfig.requiredTier}"`);
    this.h.log(`claim verified: World ID ${verdict.tier} · epoch ${verdict.epoch} · fresh one-time address`);
    const next = this.h.dispatch({ t: "QUOTE_VERIFIED", destination: verdict.destination, tier: verdict.tier });
    if (next.s !== "POLICY") return;
    this.h.oled(["VERIFIED HUMAN"]);
    await this.h.runPolicy(g);
  }

  private noVerified(g: number, reason: string): void {
    if (!this.h.live(g)) return;
    this.h.log(`NO VERIFIED RECIPIENT: ${reason}. Nothing paid.`);
    this.h.dispatch({ t: "QUOTE_FAILED", reason });
    this.h.oled(oledStates.noVerifiedRecipient());
    void this.h.say("noVerifiedRecipient");
  }

  // ------------------------------------------------------------ PAY (one-time address)
  async pay(g: number, destination: string, amount: string, token: string): Promise<void> {
    const wallet = this.h.wallet();
    if (!wallet) return void this.h.dispatch({ t: "FAIL", reason: "Wallet locked" });
    this.h.oled(oledStates.paying());

    this.h.log(`🛡️ Unshielding from Railgun straight to one-time address via Broadcaster`);
    this.h.log(`Payer is hidden by Railgun; recipient is hidden by stealth address`);
    let r: { transferHash: string; gasDropHash: string | null; gasDropError: string | null };
    try {
      const res = await payFromRailgun(wallet, { destination, amount });
      r = { transferHash: res.txHash, gasDropHash: res.gasDropHash, gasDropError: res.gasDropError };
      this.h.log(`Broadcaster confirmed unshield: ${res.txHash.slice(0, 10)}… (all payer data shielded)`);
    } catch (e) {
      // Invariant: No direct agent wallet transfers in pay path. If Railgun fails, stop visibly.
      this.h.log(`Railgun unshield failed: ${errText(e)}`);
      this.h.dispatch({ t: "FAIL", reason: `Railgun payment failed: ${errText(e)}` });
      return;
    }

    void g;
    // A sent payment is always reported, even if Stop was pressed meanwhile.
    this.h.dispatch({ t: "PAID", txHash: r.transferHash });
    this.h.log(`tx ${r.transferHash.slice(0, 10)}… (USDC)`, txUrl(r.transferHash));
    if (r.gasDropHash) this.h.log(`tx ${r.gasDropHash.slice(0, 10)}… (gas drop)`, txUrl(r.gasDropHash));
    if (r.gasDropError) this.h.log(`Payment completed, but recipient gas drop failed: ${r.gasDropError}`);
    try {
      await recordSpend(amount, r.transferHash);
    } catch (e) {
      this.h.log(`ledger update failed: ${errText(e)}`);
    }
    this.h.oled(oledStates.paid(amount, token));
    void this.h.say("paid", { amount, token });
  }
}

function firstClaim(round: QuoteSession, claims: readonly ClaimDelivery[]): Claim2Body | null {
  for (const c of claims) {
    const b = openClaim2(round, c);
    if (b) return b;
  }
  return null;
}
