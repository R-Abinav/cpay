"use client";
// /pay: the payer console on the laptop. Glasses (bridge) + earbuds in; the agent runtime (app/api/*) decides and signs.
// Flow per push-to-talk run:
//   CAPTURE down -> record earbud mic + glasses frame -> CAPTURE up -> embed centred face (local), drop frame
//   -> /api/intent (0G ears + brain) -> /api/speak "ack" -> policy preview (GET /api/pay)
//   -> over cap: Agent Pass (APPROVE ON PHONE) -> probe via relay -> exactly one claim (else NO VERIFIED RECIPIENT + QR)
//   -> verify BBS proof (UI check) -> OLED + voice confirm -> physical CONFIRM -> POST /api/pay -> /api/episode -> "Paid"
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  bindingDigest,
  buildProbe,
  resolveClaims,
  type ClaimDelivery,
  type OpenedClaim,
  type PayerSession,
  type Peer,
  type RelayMessage,
} from "@cpay/protocol";
import { initCredential, verifyProof } from "@cpay/credential";
import {
  AgentPassStartResponse,
  AgentPassStatus,
  ApiFailure,
  EpisodeResponse,
  IntentResponse,
  PayPreviewResponse,
  PayResponse,
  SpeakResponse,
  StatusResponse,
  readApi,
  type EpisodeOutcome,
  type ReplyTemplate,
} from "../../lib/api.js";
import { PushToTalk, listAudioDevices, playAudio, unlockDeviceLabels } from "../../lib/audio.js";
import { BridgeConnection, oledStates, type BridgeState, type DeviceStatus, type OledMessage } from "../../lib/bridge.js";
import { errorMessage, isNotImplemented, type DependencyId, type DependencyStatus } from "../../lib/deps.js";
import { decodeJpeg, embedFace, loadFaceEngine } from "../../lib/face/engine.js";
import { fetchIssuerPublicKey, issuerStats } from "../../lib/issuer-client.js";
import { publicConfig } from "../../lib/public-config.js";
import { qrPayload, shortCode } from "../../lib/recipient.js";
import { RelayConnection, type RelayState } from "../../lib/relay-client.js";
import { formatAmount } from "../../lib/units.js";
import { Button, DepPill, ErrorNote, Mono, NotConnected, Section, short } from "../../components/ui.js";
import { EvidencePanel, OledMirror, XrayPanel } from "./panels.js";
import { TERMINAL, mergeEvidence, newRun, type Phase, type RunView } from "./run-view.js";

const FRAME_WAIT_MS = 3000;
const PEERS_WAIT_MS = 3000;
const QR_WINDOW_MS = 55_000; // relay forgets sessions after 60 s
const APPROVAL_WAIT_MS = 5 * 60_000;

class Cancelled extends Error {}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

export function PayConsole() {
  // ---------- view state ----------
  const [run, setRun] = useState<RunView | null>(null);
  const [lastRun, setLastRun] = useState<RunView | null>(null);
  const [oled, setOled] = useState<readonly string[]>(oledStates.ready().lines);
  const [bridgeState, setBridgeState] = useState<BridgeState>("connecting");
  const [devices, setDevices] = useState<DeviceStatus>({ c3: false, cam: false });
  const [relayState, setRelayState] = useState<RelayState>("connecting");
  const [relayDetail, setRelayDetail] = useState("");
  const [serverDeps, setServerDeps] = useState<DependencyStatus[]>([]);
  const [faceModel, setFaceModel] = useState<{ ok: boolean; detail: string }>({ ok: false, detail: "loading" });
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string | null>(null);
  const [outId, setOutId] = useState<string | null>(null);
  const [micErr, setMicErr] = useState<string | null>(null);
  const [laptopCam, setLaptopCam] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);

  // ---------- refs (the async flow reads these) ----------
  const runRef = useRef<RunView | null>(null);
  const bridge = useRef<BridgeConnection | null>(null);
  const relay = useRef<RelayConnection | null>(null);
  const ptt = useRef(new PushToTalk());
  const frame = useRef<{ bitmap: ImageBitmap; bytes: number; source: "glasses" | "laptop" } | null>(null);
  const frameWaiter = useRef<(() => void) | null>(null);
  const peersWaiter = useRef<Waiter<Peer[]> | null>(null);
  const session = useRef<PayerSession | null>(null);
  const claims = useRef<ClaimDelivery[]>([]);
  const qrMode = useRef<{ since: number; waiter: Waiter<OpenedClaim> } | null>(null);
  const confirmWaiter = useRef<Waiter<"glasses" | "keyboard"> | null>(null);
  const approvalWaiter = useRef<Waiter<boolean> | null>(null);
  const laptopVideo = useRef<HTMLVideoElement>(null);
  const laptopStream = useRef<MediaStream | null>(null);
  const outIdRef = useRef<string | null>(null);
  const devicesRef = useRef(devices);
  const recordingDone = useRef<Promise<{ blob: Blob; ms: number } | null> | null>(null);

  outIdRef.current = outId;
  devicesRef.current = devices;

  const note = useCallback((n: string) => setNotes((x) => [`${new Date().toLocaleTimeString()} ${n}`, ...x].slice(0, 8)), []);

  const patch = useCallback((p: Partial<RunView> | ((r: RunView) => Partial<RunView>)) => {
    const cur = runRef.current;
    if (!cur) return;
    const next = { ...cur, ...(typeof p === "function" ? p(cur) : p) };
    runRef.current = next;
    setRun(next);
  }, []);

  const showOled = useCallback((m: OledMessage) => {
    setOled(m.lines);
    bridge.current?.oled(m);
  }, []);

  const alive = (runId: string) => {
    const r = runRef.current;
    if (!r || r.runId !== runId || TERMINAL.includes(r.phase)) throw new Cancelled();
  };

  // ---------- server helpers ----------
  const speak = useCallback(
    async (runId: string, template: ReplyTemplate, values?: { amount?: string; token?: string }) => {
      const r = await readApi(
        fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, template, ...values }) }),
        SpeakResponse,
      );
      if (runRef.current?.runId === runId) patch((cur) => ({ evidence: mergeEvidence(cur.evidence, r.evidence) }));
      if (!r.ok) {
        // Voice is a convenience, not a gate: show it, keep going.
        if (runRef.current?.runId === runId) patch({ voiceNote: `voice unavailable: ${r.message}` });
        return;
      }
      playAudio(r.audioBase64, r.mime, outIdRef.current).catch((e) => note(`playback: ${errorMessage(e)}`));
    },
    [note, patch],
  );

  const logEpisode = useCallback(
    async (runId: string, outcome: EpisodeOutcome) => {
      const r = await readApi(
        fetch("/api/episode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, outcome }) }),
        EpisodeResponse,
      );
      const apply = (v: RunView): RunView =>
        r.ok
          ? { ...v, rootHash: r.rootHash, storageTxHash: r.txHash, evidence: mergeEvidence(v.evidence, r.evidence) }
          : { ...v, episodeError: `episode not logged: ${r.message}`, evidence: mergeEvidence(v.evidence, r.evidence) };
      if (runRef.current?.runId === runId) {
        const next = apply(runRef.current);
        runRef.current = next;
        setRun(next);
        setLastRun(next);
      } else {
        setLastRun((l) => (l && l.runId === runId ? apply(l) : l));
      }
    },
    [],
  );

  /** End the run in a terminal phase: OLED, voice, episode. */
  const finish = useCallback(
    (runId: string, phase: Phase, message: string, opts: { oled?: OledMessage; voice?: ReplyTemplate; outcome?: EpisodeOutcome; dependency?: { id: DependencyId; detail: string } } = {}) => {
      const cur = runRef.current;
      if (!cur || cur.runId !== runId || TERMINAL.includes(cur.phase)) return;
      patch({ phase, message, dependency: opts.dependency, issuerRequests: issuerStats.requests - (cur.issuerRequests ?? 0) });
      if (opts.oled) showOled(opts.oled);
      if (opts.voice) void speak(runId, opts.voice, cur.intent ? { amount: cur.intent.amount, token: cur.intent.symbol } : undefined);
      qrMode.current?.waiter.reject(new Cancelled());
      qrMode.current = null;
      confirmWaiter.current?.reject(new Cancelled());
      approvalWaiter.current?.reject(new Cancelled());
      setLastRun(runRef.current);
      if (opts.outcome) void logEpisode(runId, opts.outcome);
      setTimeout(() => {
        if (runRef.current?.runId === runId) showOled(oledStates.ready());
      }, 8000);
    },
    [logEpisode, patch, showOled, speak],
  );

  const stopOnFailure = useCallback(
    (runId: string, f: ApiFailure, fallbackDep: DependencyId) => {
      patch((cur) => ({ evidence: mergeEvidence(cur.evidence, f.evidence) }));
      const dep = { id: f.dependency ?? fallbackDep, detail: f.message };
      switch (f.stop) {
        case "brain_offline":
          return finish(runId, "brain_offline", "BRAIN OFFLINE - PAUSED. 0G is unreachable or not wired; nothing will be paid.", {
            oled: oledStates.brainOffline(),
            outcome: "error",
            dependency: dep,
          });
        case "not_connected":
          return finish(runId, "not_connected", `${f.message}`, { oled: oledStates.cancelled(), outcome: "error", dependency: dep });
        case "refused":
          return finish(runId, "refused", `Didn't get a payable amount: ${f.message}`, { oled: oledStates.ready(), outcome: "refused" });
        case "policy_denied":
          return finish(runId, "policy_denied", f.message, { oled: oledStates.cancelled(), voice: "cancelled", outcome: "policy_denied" });
        case "approval_required":
        case "approval_denied":
          return finish(runId, "approval_denied", f.message, { oled: oledStates.cancelled(), voice: "denied", outcome: "approval_denied" });
        default:
          return finish(runId, "error", f.message, { oled: oledStates.cancelled(), outcome: "error", dependency: f.dependency ? dep : undefined });
      }
    },
    [finish, patch],
  );

  // ---------- frames ----------
  const takeFrame = useCallback(async (bitmap: ImageBitmap, bytes: number, source: "glasses" | "laptop") => {
    frame.current?.bitmap.close();
    frame.current = { bitmap, bytes, source };
    frameWaiter.current?.();
    frameWaiter.current = null;
  }, []);

  const grabLaptopFrame = useCallback(async () => {
    const v = laptopVideo.current;
    if (!v || !v.videoWidth) return;
    const bmp = await createImageBitmap(v);
    await takeFrame(bmp, v.videoWidth * v.videoHeight * 4, "laptop");
  }, [takeFrame]);

  const waitFrame = useCallback(async (): Promise<boolean> => {
    if (frame.current) return true;
    if (bridge.current && devicesRef.current.cam) bridge.current.send({ type: "capture_request" });
    await new Promise<void>((res) => {
      frameWaiter.current = res;
      setTimeout(res, FRAME_WAIT_MS);
    });
    return !!frame.current;
  }, []);

  // ---------- relay ----------
  const getPeers = useCallback((): Promise<Peer[]> => {
    const r = relay.current;
    if (!r?.isOpen) return Promise.reject(new Error(relayDetail || "relay not connected"));
    return new Promise<Peer[]>((resolve, reject) => {
      peersWaiter.current = { resolve, reject };
      r.send({ type: "payer.hello" });
      setTimeout(() => reject(new Error("relay did not answer payer.hello")), PEERS_WAIT_MS);
    });
  }, [relayDetail]);

  const onRelayMessage = useCallback(
    (m: RelayMessage) => {
      if (m.type === "peers") {
        peersWaiter.current?.resolve(m.peers);
        peersWaiter.current = null;
      } else if (m.type === "claim") {
        const s = session.current;
        if (!s || m.sessionId !== s.sessionId) return;
        claims.current.push(m);
        patch((cur) => ({
          relay: { ...cur.relay, claims: cur.relay.claims + 1, claimBytes: cur.relay.claimBytes + JSON.stringify(m).length, claimAts: [...cur.relay.claimAts, Date.now()] },
        }));
        const q = qrMode.current;
        if (q) {
          const late = claims.current.slice(q.since);
          const r = resolveClaims(s, late);
          if (r.ok) q.waiter.resolve(r.claim);
        }
      } else if (m.type === "error") {
        note(`relay: ${m.message}`);
      }
    },
    [note, patch],
  );

  // ---------- the run ----------
  const startRun = useCallback(() => {
    const cur = runRef.current;
    if (cur && !TERMINAL.includes(cur.phase) && cur.phase !== "ready") return; // one run at a time
    const runId = crypto.randomUUID();
    const r = newRun(runId);
    r.issuerRequests = issuerStats.requests; // baseline; finish() turns it into a delta
    runRef.current = r;
    setRun(r);
    session.current = null;
    claims.current = [];
    frame.current?.bitmap.close();
    frame.current = null;
    showOled(oledStates.listening());
    if (!devicesRef.current.cam && laptopCam) void grabLaptopFrame();
    try {
      if (!ptt.current.isOpen) throw new Error("microphone not open: pick your earbuds above");
      ptt.current.start();
    } catch (e) {
      setMicErr(errorMessage(e));
    }
  }, [grabLaptopFrame, laptopCam, showOled]);

  const runAfterCapture = useCallback(
    async (runId: string) => {
      const clip = await (recordingDone.current ?? Promise.resolve(null));
      alive(runId);
      patch({ phase: "thinking", message: "Understanding…" });

      // Face: embed the centred face locally, then delete the frame.
      const embedP = (async () => {
        const got = await waitFrame();
        const f = frame.current;
        frame.current = null;
        if (!got || !f) return { embedding: null as Float32Array | null, faces: 0, bytes: 0, source: null };
        try {
          const r = await embedFace(f.bitmap, f.bitmap.width, f.bitmap.height, "centre");
          return { embedding: r?.embedding ?? null, faces: r?.faces ?? 0, bytes: f.bytes, source: f.source };
        } finally {
          f.bitmap.close();
        }
      })();

      if (!clip) {
        embedP.catch(() => undefined);
        return finish(runId, "refused", "No audio recorded. Hold CAPTURE while you speak.", { oled: oledStates.ready() });
      }

      // Ears + brain (0G, private mode)
      const form = new FormData();
      form.set("runId", runId);
      form.set("audio", clip.blob, "clip");
      const intent = await readApi(fetch("/api/intent", { method: "POST", body: form }), IntentResponse);
      alive(runId);
      if (!intent.ok) {
        embedP.catch(() => undefined);
        return stopOnFailure(runId, intent, "zerog");
      }
      patch((c) => ({
        evidence: mergeEvidence(c.evidence, intent.evidence),
        transcript: intent.transcript,
        intent: {
          amount: intent.intent.amount,
          symbol: intent.token.symbol,
          amountBase: intent.amountBase,
          tokenAddress: intent.token.address,
          decimals: intent.token.decimals,
          requestIds: intent.requestIds,
        },
        message: `${intent.intent.amount} ${intent.token.symbol}`,
      }));
      void speak(runId, "ack", { amount: intent.intent.amount, token: intent.token.symbol });

      // Policy preview (the server re-checks everything at signing time)
      const preview = await readApi(fetch(`/api/pay?amount=${intent.amountBase}&token=${intent.token.symbol}`), PayPreviewResponse);
      alive(runId);
      if (!preview.ok) {
        embedP.catch(() => undefined);
        return stopOnFailure(runId, preview, "agent-wallet");
      }
      patch({ wallet: preview.wallet, policy: preview.policy ?? undefined });
      if (preview.policy?.decision === "deny") {
        embedP.catch(() => undefined);
        const why = preview.policy.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ");
        return finish(runId, "policy_denied", `Policy: ${why}`, { oled: oledStates.cancelled(), voice: "cancelled", outcome: "policy_denied" });
      }

      // Face embedding must exist before probing
      const face = await embedP;
      alive(runId);
      patch((c) => ({ frame: { bytes: face.bytes, faces: face.faces, source: face.source, deleted: true } }));
      if (!face.embedding) {
        return finish(runId, "unverified", face.source ? "No face in view of the glasses." : "No frame from the glasses camera.", {
          oled: oledStates.noVerifiedRecipient(),
          voice: "noRecipient",
          outcome: "no_recipient",
        });
      }

      // Session (built now so an Agent Pass approval can be bound to its sessionId)
      let peers: Peer[];
      try {
        peers = await getPeers();
      } catch (e) {
        return finish(runId, "not_connected", errorMessage(e), { oled: oledStates.noVerifiedRecipient(), outcome: "no_recipient", dependency: { id: "relay", detail: errorMessage(e) } });
      }
      alive(runId);
      if (peers.length === 0) {
        return finish(runId, "unverified", "No enrolled phones are connected to the relay.", {
          oled: oledStates.noVerifiedRecipient(),
          voice: "noRecipient",
          outcome: "no_recipient",
        });
      }
      const built = buildProbe({
        peers,
        embedding: face.embedding,
        chainId: publicConfig.chainId,
        token: intent.token.address,
        amount: intent.amountBase,
      });
      session.current = built.session;
      claims.current = [];
      patch({ sessionId: built.session.sessionId, shortCode: shortCode(built.session.sessionId) });

      // Over cap -> World Agent Pass (single-use, bound to {sessionId, amount, token})
      if (preview.policy?.decision === "needs_approval") {
        patch({ phase: "approval", message: "Over your limit: approve on your phone (World App).", approvalState: "pending" });
        showOled(oledStates.approveOnPhone());
        void speak(runId, "needApproval", { amount: intent.intent.amount, token: intent.token.symbol });
        const q = new URLSearchParams({ runId, sessionId: built.session.sessionId, amount: intent.amountBase, token: intent.token.address });
        const start = await readApi(fetch(`/api/agent-pass/start?${q}`), AgentPassStartResponse);
        alive(runId);
        if (!start.ok) return stopOnFailure(runId, start, "agent-pass");
        patch({ approvalUrl: start.url });
        window.open(start.url, "cpay-agent-pass", "popup,width=480,height=720"); // may be blocked: the button below also opens it
        let approved: boolean;
        try {
          approved = await new Promise<boolean>((resolve, reject) => {
            approvalWaiter.current = { resolve, reject };
            const sid = built.session.sessionId;
            const poll = setInterval(async () => {
              const s = await readApi(fetch(`/api/agent-pass/status?sessionId=${sid}`), AgentPassStatus);
              if (s.ok && s.state === "approved") resolve(true);
              if (s.ok && s.state === "denied") resolve(false);
            }, 2000);
            const t = setTimeout(() => resolve(false), APPROVAL_WAIT_MS);
            const done = () => {
              clearInterval(poll);
              clearTimeout(t);
            };
            approvalWaiter.current = {
              resolve: (v) => {
                done();
                resolve(v);
              },
              reject: (e) => {
                done();
                reject(e);
              },
            };
          });
        } finally {
          approvalWaiter.current = null;
        }
        alive(runId);
        patch({ approvalState: approved ? "approved" : "denied" });
        if (!approved) {
          return finish(runId, "approval_denied", "Agent Pass denied or expired. Nothing was paid.", {
            oled: oledStates.cancelled(),
            voice: "denied",
            outcome: "approval_denied",
          });
        }
      }

      // Probe -> exactly one claim
      patch({ phase: "probing", message: "Asking nearby phones…" });
      let sent: number;
      try {
        sent = relay.current!.send(built.message);
      } catch (e) {
        return finish(runId, "not_connected", errorMessage(e), { oled: oledStates.noVerifiedRecipient(), outcome: "no_recipient", dependency: { id: "relay", detail: errorMessage(e) } });
      }
      patch((c) => ({ relay: { ...c.relay, peers: peers.length, probeBytes: sent, probeAt: Date.now() } }));
      await new Promise((r) => setTimeout(r, publicConfig.claimTimeoutMs));
      alive(runId);
      const res = resolveClaims(built.session, claims.current);
      let claim: OpenedClaim;
      if (res.ok) {
        claim = res.claim;
      } else {
        // NO VERIFIED RECIPIENT -> QR fallback on the same session
        const qr = await QRCode.toDataURL(qrPayload(built.session.sessionId), { margin: 1, width: 320 }).catch(() => undefined);
        patch({
          phase: "no_recipient",
          message: res.reason === "multiple" ? `${res.count} phones answered: refusing to guess. Recipient can claim with the QR.` : "No verified recipient. Recipient can claim with the QR.",
          qrDataUrl: qr,
        });
        showOled(oledStates.noVerifiedRecipient());
        void speak(runId, "noRecipient");
        try {
          claim = await new Promise<OpenedClaim>((resolve, reject) => {
            qrMode.current = { since: claims.current.length, waiter: { resolve, reject } };
            setTimeout(() => reject(new Error("timeout")), QR_WINDOW_MS);
          });
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          return finish(runId, "unverified", "No verified recipient. Nothing was paid.", { oled: oledStates.noVerifiedRecipient(), outcome: "no_recipient" });
        } finally {
          qrMode.current = null;
        }
        alive(runId);
        patch({ qrDataUrl: undefined });
      }

      // Verify the BBS proof against the issuer key + the recomputed binding (UI check; /api/pay re-verifies)
      patch({ phase: "verifying", message: "Verifying proof…", destination: claim.body.destination });
      try {
        await initCredential();
        const pub = await fetchIssuerPublicKey(publicConfig.issuerUrl);
        const digest = bindingDigest({
          sessionNonce: built.session.sessionNonce,
          destination: claim.body.destination,
          chainId: built.session.chainId,
          token: built.session.token,
          amount: built.session.amount,
        });
        const v = await verifyProof(claim.body.credentialProof, pub, digest);
        if (v.tier !== "orb") throw new Error(`tier ${v.tier} is not Proof of Human`);
        patch({ verified: v });
      } catch (e) {
        alive(runId);
        if (isNotImplemented(e)) {
          return finish(runId, "not_connected", "Can't verify the recipient's proof yet.", {
            oled: oledStates.noVerifiedRecipient(),
            outcome: "no_recipient",
            dependency: { id: "credential", detail: "package not implemented yet" },
          });
        }
        return finish(runId, "unverified", `Recipient proof rejected: ${errorMessage(e)}. Nothing was paid.`, {
          oled: oledStates.noVerifiedRecipient(),
          voice: "noRecipient",
          outcome: "no_recipient",
        });
      }
      alive(runId);

      // OLED + voice confirm -> physical CONFIRM
      patch({ phase: "confirm", message: `Verified human · ${intent.intent.amount} ${intent.token.symbol} · press CONFIRM` });
      showOled(oledStates.verified(formatAmount(BigInt(intent.amountBase), intent.token.decimals), intent.token.symbol));
      void speak(runId, "confirm", { amount: intent.intent.amount, token: intent.token.symbol });
      const source = await new Promise<"glasses" | "keyboard">((resolve, reject) => {
        confirmWaiter.current = { resolve, reject };
      }).finally(() => {
        confirmWaiter.current = null;
      });
      const confirmedAt = Date.now();
      alive(runId);

      // The only signer
      patch({ phase: "paying", message: "Paying from the agent wallet…", confirmSource: source });
      const pay = await readApi(
        fetch("/api/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            session: {
              sessionId: built.session.sessionId,
              sessionNonce: built.session.sessionNonce,
              chainId: built.session.chainId,
              token: built.session.token,
              amount: built.session.amount,
            },
            claim: { destination: claim.body.destination, credentialProof: claim.body.credentialProof },
            confirm: { sessionId: built.session.sessionId, at: confirmedAt, source },
          }),
        }),
        PayResponse,
      );
      alive(runId);
      if (!pay.ok) return stopOnFailure(runId, pay, "agent-wallet");
      patch({ pay });
      finish(runId, "paid", `Paid ${intent.intent.amount} ${intent.token.symbol}.`, { oled: oledStates.paid(), voice: "paid", outcome: "paid" });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finish, getPeers, patch, showOled, speak, stopOnFailure, waitFrame],
  );

  const endCapture = useCallback(() => {
    const cur = runRef.current;
    if (!cur || cur.phase !== "listening") return;
    recordingDone.current = ptt.current.stop();
    runAfterCapture(cur.runId).catch((e) => {
      if (e instanceof Cancelled) return;
      finish(cur.runId, "error", errorMessage(e), { oled: oledStates.cancelled(), outcome: "error" });
    });
  }, [finish, runAfterCapture]);

  const onConfirm = useCallback((source: "glasses" | "keyboard") => {
    if (runRef.current?.phase === "confirm") confirmWaiter.current?.resolve(source);
  }, []);

  const onCancel = useCallback(() => {
    const cur = runRef.current;
    if (!cur || TERMINAL.includes(cur.phase) || cur.phase === "ready") return;
    if (cur.phase === "listening") void ptt.current.stop();
    finish(cur.runId, "cancelled", "Cancelled. Nothing was paid.", {
      oled: oledStates.cancelled(),
      voice: cur.intent ? "cancelled" : undefined,
      outcome: "cancelled",
    });
  }, [finish]);

  // ---------- connections ----------
  const handlers = useRef({ startRun, endCapture, onConfirm, onCancel, takeFrame, onRelayMessage });
  handlers.current = { startRun, endCapture, onConfirm, onCancel, takeFrame, onRelayMessage };

  useEffect(() => {
    const b = new BridgeConnection(publicConfig.bridgeWsUrl, {
      onState: (s) => {
        setBridgeState(s);
        if (s !== "open") setDevices({ c3: false, cam: false });
      },
      onMessage: (m) => {
        const h = handlers.current;
        switch (m.type) {
          case "hello":
          case "device_status":
            setDevices(m.devices);
            return;
          case "button":
            if (m.event === "capture_down") h.startRun();
            else if (m.event === "capture_up") h.endCapture();
            else if (m.event === "confirm") h.onConfirm("glasses");
            else h.onCancel();
            return;
          case "frame": {
            const cur = runRef.current;
            if (!cur || !["listening", "thinking"].includes(cur.phase)) return; // not in a capture: drop
            decodeJpeg(m.dataBase64).then((bmp) => h.takeFrame(bmp, m.bytes, "glasses"), () => note("bad frame from glasses"));
            return;
          }
          case "frame_error":
            note(`glasses camera: ${m.reason}${m.detail ? ` (${m.detail})` : ""}`);
            return;
          case "error":
            note(`bridge: ${m.reason}`);
        }
      },
    });
    bridge.current = b;
    b.start();
    b.oled(oledStates.ready());
    return () => b.stop();
  }, [note]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const c = new RelayConnection(publicConfig.relayUrl, {
        onMessage: (m) => handlers.current.onRelayMessage(m),
        onState: (s, d) => {
          setRelayState(s);
          setRelayDetail(d ?? "");
          if (s === "closed" && !stop) timer = setTimeout(connect, 3000);
        },
      });
      relay.current = c;
      c.connect();
    };
    connect();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      relay.current?.close();
    };
  }, []);

  useEffect(() => {
    readApi(fetch("/api/status"), StatusResponse).then((r) => {
      if ("deps" in r) setServerDeps(r.deps);
    });
    loadFaceEngine().then(
      () => setFaceModel({ ok: true, detail: "YuNet + SFace loaded (self-hosted)" }),
      (e) => setFaceModel({ ok: false, detail: errorMessage(e) }),
    );
    fetchIssuerPublicKey(publicConfig.issuerUrl).catch(() => undefined);
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const d = e.data as { type?: string; approved?: boolean; sessionId?: string | null };
      if (d?.type !== "cpay-agent-pass") return;
      if (d.sessionId && d.sessionId !== session.current?.sessionId) return;
      approvalWaiter.current?.resolve(!!d.approved);
    };
    window.addEventListener("message", onMsg);
    const savedMic = localStorage.getItem("cpay.mic");
    const savedOut = localStorage.getItem("cpay.out");
    setMicId(savedMic);
    setOutId(savedOut);
    const p = ptt.current;
    return () => {
      window.removeEventListener("message", onMsg);
      p.close();
    };
  }, []);

  // Mic: open the chosen input once so CAPTURE starts recording instantly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await unlockDeviceLabels();
        const d = await listAudioDevices();
        if (cancelled) return;
        setMics(d.inputs);
        setOuts(d.outputs);
        await ptt.current.open(micId);
        setMicErr(null);
      } catch (e) {
        if (!cancelled) setMicErr(`microphone: ${errorMessage(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [micId]);

  // Laptop camera fallback (only when the glasses camera isn't connected)
  useEffect(() => {
    if (!laptopCam) {
      laptopStream.current?.getTracks().forEach((t) => t.stop());
      laptopStream.current = null;
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }).then(
      (s) => {
        laptopStream.current = s;
        if (laptopVideo.current) {
          laptopVideo.current.srcObject = s;
          void laptopVideo.current.play();
        }
      },
      (e) => note(`laptop camera: ${errorMessage(e)}`),
    );
  }, [laptopCam, note]);

  // Keyboard fallback when the glasses' buttons (C3) aren't connected: hold Space = CAPTURE, Enter = CONFIRM, Esc = CANCEL.
  const keyboardActive = !devices.c3;
  useEffect(() => {
    if (!keyboardActive) return;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault();
        handlers.current.startRun();
      } else if (e.code === "Enter") handlers.current.onConfirm("keyboard");
      else if (e.code === "Escape") handlers.current.onCancel();
    };
    const up = (e: KeyboardEvent) => {
      if (!typing(e) && e.code === "Space") handlers.current.endCapture();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [keyboardActive]);

  // ---------- render ----------
  const relayPill = relayState === "open" ? "ok" : relayState === "not_configured" ? "not_connected" : relayState === "connecting" ? "unknown" : "offline";
  const bridgePill = bridgeState === "open" ? "ok" : bridgeState === "not_configured" ? "not_connected" : bridgeState === "connecting" ? "unknown" : "offline";
  const shown = run ?? lastRun;
  const phase = run?.phase ?? "ready";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-4">
        <Section title="Connections">
          <div className="flex flex-wrap gap-2">
            {serverDeps.map((d) => (
              <DepPill key={d.id} id={d.id} state={d.state} detail={d.detail} />
            ))}
            <DepPill id="relay" state={relayPill} detail={relayDetail} />
            <DepPill id="bridge" state={bridgePill} detail={`buttons ${devices.c3 ? "on" : "off"}, camera ${devices.cam ? "on" : "off"}`} />
            <DepPill id="face-model" state={faceModel.ok ? "ok" : faceModel.detail === "loading" ? "unknown" : "not_connected"} detail={faceModel.detail} />
            {run?.wallet && <DepPill id="agent-wallet" state="ok" detail={run.wallet.address} />}
          </div>
          {bridgeState === "open" && (
            <p className="mt-2 text-xs text-neutral-500">
              Glasses: buttons {devices.c3 ? "connected" : "not connected"}, camera {devices.cam ? "connected" : "not connected"}.
            </p>
          )}
        </Section>

        <Section title="Earbuds">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-neutral-400">
              Microphone
              <select
                className="mt-1 min-h-11 w-full rounded-lg bg-neutral-800 px-2 text-sm"
                value={micId ?? ""}
                onChange={(e) => {
                  setMicId(e.target.value || null);
                  localStorage.setItem("cpay.mic", e.target.value);
                }}
              >
                <option value="">System default</option>
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-400">
              Speaker
              <select
                className="mt-1 min-h-11 w-full rounded-lg bg-neutral-800 px-2 text-sm"
                value={outId ?? ""}
                onChange={(e) => {
                  setOutId(e.target.value || null);
                  localStorage.setItem("cpay.out", e.target.value);
                }}
              >
                <option value="">System default</option>
                {outs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>
                ))}
              </select>
            </label>
          </div>
          {micErr && <div className="mt-2"><ErrorNote>{micErr}</ErrorNote></div>}
        </Section>

        <Section title="Agent">
          <div className="grid grid-cols-[auto_1fr] items-start gap-4">
            <OledMirror lines={oled} bridgeOpen={bridgeState === "open" && devices.c3} />
            <div className="space-y-2">
              <StateBanner phase={phase} message={run?.message ?? "Hold CAPTURE and say: “Hey Pay, pay her 2 USDC”"} />
              {run?.transcript !== undefined && (
                <p className="text-sm text-neutral-400">
                  You said: <span className="text-neutral-200">&ldquo;{run.transcript}&rdquo;</span>
                </p>
              )}
              {run?.voiceNote && <p className="text-xs text-amber-300">{run.voiceNote}</p>}
            </div>
          </div>

          {run?.dependency && (phase === "not_connected" || phase === "brain_offline" || phase === "error") && (
            <div className="mt-3"><NotConnected id={run.dependency.id} detail={run.dependency.detail} /></div>
          )}

          {run?.wallet && (
            <div className="mt-3 rounded-xl bg-neutral-800/60 p-3 text-xs text-neutral-300">
              <div>
                Agent wallet <Mono>{short(run.wallet.address)}</Mono>:{" "}
                {run.wallet.tokenBalance !== null ? `${formatAmount(BigInt(run.wallet.tokenBalance), run.wallet.decimals)} ${run.wallet.symbol}` : "balance unavailable"}
              </div>
              <div>
                Caps: {formatAmount(BigInt(run.wallet.paymentCap), run.wallet.decimals)} per payment ·{" "}
                {formatAmount(BigInt(run.wallet.spentToday), run.wallet.decimals)} / {formatAmount(BigInt(run.wallet.dailyCap), run.wallet.decimals)} today
              </div>
              {run.policy && (
                <ul className="mt-1">
                  {run.policy.checks.map((c) => (
                    <li key={c.id} className={c.ok ? "text-emerald-300" : c.approvable ? "text-amber-300" : "text-red-300"}>
                      {c.ok ? "✓" : c.approvable ? "▲" : "✗"} {c.id.replace("_", " ")}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {phase === "approval" && run?.approvalUrl && (
            <a href={run.approvalUrl} target="cpay-agent-pass" rel="opener" className="mt-3 block min-h-12 rounded-xl bg-white px-5 py-3 text-center font-semibold text-black">
              Open World Agent Pass approval
            </a>
          )}

          {phase === "no_recipient" && run?.qrDataUrl && (
            <div className="mt-3 flex flex-col items-center gap-2 rounded-xl bg-white p-3 text-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={run.qrDataUrl} alt="claim QR" className="w-56" />
              <div className="text-sm">
                Recipient: open CPay → &ldquo;Claim with QR&rdquo; · code <b className="font-mono">{run.shortCode}</b>
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button onClick={() => onConfirm("keyboard")} disabled={phase !== "confirm" || !keyboardActive}>
              CONFIRM
            </Button>
            <Button tone="danger" onClick={onCancel} disabled={TERMINAL.includes(phase) || phase === "ready"}>
              CANCEL
            </Button>
          </div>
          {keyboardActive ? (
            <p className="mt-2 text-xs text-amber-300">
              Glasses buttons not connected: keyboard fallback active (hold Space = CAPTURE, Enter = CONFIRM, Esc = CANCEL).
            </p>
          ) : (
            <p className="mt-2 text-xs text-neutral-500">Use the buttons on the glasses: CAPTURE (hold), CONFIRM, CANCEL.</p>
          )}
          {!devices.cam && (
            <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
              <input type="checkbox" checked={laptopCam} onChange={(e) => setLaptopCam(e.target.checked)} className="h-5 w-5" />
              Glasses camera not connected: use this laptop&apos;s camera instead
            </label>
          )}
          <video ref={laptopVideo} muted playsInline className={laptopCam && !devices.cam ? "mt-2 w-40 rounded-lg" : "hidden"} />
          {notes.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs text-neutral-500">
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </Section>

        {shown?.pay && (
          <Section title="Payment">
            <p className="text-sm">
              Sent {formatAmount(BigInt(shown.pay.amountBase), shown.intent?.decimals ?? 6)} {shown.pay.symbol} to one-time address{" "}
              <Mono>{shown.pay.destination}</Mono>
            </p>
            <p className="mt-1 text-xs">
              transfer <Mono>{shown.pay.transferHash}</Mono>
              {shown.pay.gasDropHash && (
                <>
                  {" "}· gas drop <Mono>{shown.pay.gasDropHash}</Mono>
                </>
              )}
              {shown.pay.approvalUsed && <span className="ml-1 text-amber-300">(Agent Pass approval used)</span>}
            </p>
          </Section>
        )}
      </div>

      <div className="space-y-4">
        <EvidencePanel run={shown} />
        <XrayPanel run={shown && TERMINAL.includes(shown.phase) ? shown : lastRun} />
      </div>
    </div>
  );
}

const BANNER: Record<Phase, { label: string; cls: string }> = {
  ready: { label: "READY", cls: "bg-neutral-800" },
  listening: { label: "LISTENING", cls: "bg-sky-600" },
  thinking: { label: "THINKING", cls: "bg-sky-800" },
  approval: { label: "APPROVE ON PHONE", cls: "bg-amber-500 text-black" },
  probing: { label: "LOOKING FOR RECIPIENT", cls: "bg-sky-800" },
  no_recipient: { label: "NO VERIFIED RECIPIENT", cls: "bg-amber-600 text-black" },
  unverified: { label: "NO VERIFIED RECIPIENT", cls: "bg-amber-700" },
  verifying: { label: "VERIFYING", cls: "bg-sky-800" },
  confirm: { label: "VERIFIED HUMAN · OK?", cls: "bg-emerald-600" },
  paying: { label: "PAYING", cls: "bg-emerald-800" },
  paid: { label: "PAID", cls: "bg-emerald-500 text-black" },
  cancelled: { label: "CANCELLED", cls: "bg-neutral-700" },
  approval_denied: { label: "DENIED · NOTHING PAID", cls: "bg-red-700" },
  policy_denied: { label: "POLICY DENIED", cls: "bg-red-700" },
  refused: { label: "NOT UNDERSTOOD", cls: "bg-neutral-700" },
  brain_offline: { label: "BRAIN OFFLINE - PAUSED", cls: "bg-red-600" },
  not_connected: { label: "NOT CONNECTED", cls: "bg-amber-700" },
  error: { label: "STOPPED", cls: "bg-red-800" },
};

function StateBanner({ phase, message }: { phase: Phase; message: string }) {
  const b = BANNER[phase];
  return (
    <div role="status" aria-live="polite" className={`rounded-xl px-4 py-3 ${b.cls}`}>
      <div className="text-xl font-bold tracking-wide">{b.label}</div>
      <div className="text-sm opacity-90">{message}</div>
    </div>
  );
}
