# CPay architecture

## Components

| Component | Runs on | Holds | Never holds |
|---|---|---|---|
| Glasses (ESP32-S3) | the payer's head | camera, OLED, 3 buttons (CAPTURE = push-to-talk, CONFIRM, CANCEL) | identities, keys |
| Earbuds (Bluetooth) | the payer's ears | mic (voice in) + speaker (agent voice out), paired to the payer laptop | anything; they're just audio I/O |
| Bridge | payer's laptop (Node) | Wi-Fi link to the glasses; forwards frames + button events to the payer app; drives the OLED | keys |
| Payer app (`apps/web` `/pay`) | payer's browser | earbud mic capture + audio playback, embedding model, BBS verifier (UI-side check), Privacy X-ray | **any key**, anyone's face template or wallet |
| Recipient app (`apps/web` `/receive`) | recipient's phone browser | own face template, BBS card + holder secret, stealth keys, Railgun 0zk keys | anything about other people |
| Relay (`apps/relay`) | anywhere, anyone can run one | per-connection ephemeral pubkeys, ciphertext in flight | everything else |
| **Agent runtime** (`apps/web` `app/api/*`) | payer's laptop (localhost) | **agent wallet key**, policy engine + spent-today ledger, 0G router key, 0G Storage key, Agent Pass client secret | faces, the payer's main wallet key, recipients' anything |
| Agent wallet | Sepolia EOA | a small USDC + ETH budget the payer tops up; the only source of payments | the payer's main funds |
| Issuer (`apps/issuer`) | our server | World RP signing key, BBS issuer key, used nullifiers | faces, wallets, payments |
| 0G Private Computer / router | 0G | speech-to-text + intent (private mode, TEE, zero retention); text-to-speech of our template replies (standard/verified mode) | keys, faces |
| 0G Storage | 0G | encrypted episode logs + request IDs | plaintext PII |
| Ethereum Sepolia | chain | USDC transfers to one-time addresses / Railgun commitments | links to identities |

## (0) Recipient onboarding (once, about 60 s)

1. The recipient opens `/receive` on their phone.
2. Keys are derived on-device:
   - stealth keys: `keysFromSignature(walletSig)` over `KEY_DERIVATION_MESSAGE`, so they're recoverable from the wallet
   - BBS holder secret `s`
   - Railgun 0zk wallet (full mode)
3. Face enrolment: 5+ captures → embeddings → `buildTemplate()`. Store it encrypted in IndexedDB. It is never uploaded.
4. BBS blind commitment `C` to `s`.
5. World IDKit 4 with the **Proof of Human** credential, action `cpay-recipient-v1`, signal = `hash(C)`. The RP signature is generated server-side by the issuer.
6. The issuer:
   - forwards the IDKit payload as-is to `POST https://developer.world.org/api/v4/verify/{rp_id}`, checks `success` and `environment`, and checks signal == `hash(C)`
   - inserts `(nullifier, action)` with a UNIQUE constraint and rejects repeats
   - blind-signs `[s (hidden), tier=orb, epoch=YYYY-MM]` and returns σ
7. The recipient verifies σ and stores the card. Done.

Why Proof of Human (the IDKit judges ask for the "minimum sufficient credential"): every card lets a phone answer face probes. Sybil cards would mean fake claimants, so we need strict one-human-one-card. Selfie Check is medium assurance and doesn't guarantee that.

## (1)–(8) Payment

```
glasses CAPTURE (push-to-talk) --(frame, button)--> bridge --> payer app
payer app: records the earbud mic while CAPTURE is held (or ~4 s): "Hey Pay, pay her 2 USDC"
payer app: embed centred face locally; delete frame
payer app --(audio)--> /api/intent --> 0G router, private mode: whisper-large-v3 -> text, glm-5.3 -> {amount, token, mode}
           request IDs from X-Request-ID / x_0g_trace.request_id
payer app --(template text)--> /api/speak --> 0G TTS --> earbuds: "Sure, I'll initiate a 2 USDC payment."
agent runtime: policy(amount, token, chain, per-payment cap, daily cap, agent wallet balance)
           over cap -> voice + OLED "APPROVE ON PHONE" -> World Agent Pass step-up (OIDC, max_age=0, acr orb/orb-face),
           validated by the agent runtime (/api/agent-pass/callback), not the issuer
           -> a single-use approval bound to {sessionId, amount, token}; denied/expired -> nothing paid, voice says so
payer app --payer.hello--> relay --peers[{peerId, pub}]--> payer app
payer app --probe{sessionId, payerPub, items[{peerId, sealed ProbeBody}]}--> relay --> each recipient
each recipient: open box -> cosine(embedding, own template) >= threshold ?
           no  -> stay silent (send nothing)
           yes -> destination = createOneTimeDestination(keys)  (or fresh 0zk address in full mode)
                  proof = BBS.prove(card, reveal[tier, epoch], hide[s], presentationHeader = bindingDigest(...))
                  --claim{sessionId, sealed ClaimBody}--> relay --> payer
payer app: openClaim (trial-decrypt against probed peers)
           exactly ONE valid claim within timeout, else abort -> QR fallback
           verify BBS proof against issuer public key + recomputed bindingDigest
bridge -> OLED: "verified human · 2 USDC · OK?" + voice "Verified human. 2 USDC. Confirm?"  (physical CONFIRM/CANCEL)
payer app --POST /api/pay {sessionId, intent+requestIds, claim, approval?, confirmedAt}--> agent runtime
agent runtime (the ONLY signer): re-verify BBS proof vs issuer key + recomputed bindingDigest, re-run policy,
           check the Agent Pass approval if over cap, then AGENT WALLET signs:
           lite: payToDestination(USDC + gas drop)   full (roadmap): Railgun private transfer
log:     encrypt {decision, requestIds, policyResult, txHash, timestamps} -> 0G Storage; keep root hash
speak:   "Paid 2 USDC." / "Cancelled." / "No verified recipient." / "Approval denied, nothing was paid." 
```

Message schemas: `packages/protocol/src/messages.ts`. Sealing: X25519 → HKDF-SHA256 → AES-256-GCM with context `probe:<sessionId>` / `claim:<sessionId>`.

## Modes

| | Lite (build first) | Full |
|---|---|---|
| Status | **building this weekend** | **roadmap** |
| Recipient hidden | yes: recipient-generated ERC-5564 address, no public announcement | yes: 0zk |
| Payer hidden | no (the agent wallet is public) | yes |
| Amount hidden | no | yes |
| Tech | `@cpay/stealth`, Circle USDC on Sepolia | `@kohaku-eth/railgun` on Sepolia (shield → private transfer); proofs need `@railgun-community/circuit-artifacts` |
| Gas for the recipient later | payer includes a gas drop | relayer/broadcaster |

## Who learns what (goes in the README CROPS "P" line)

| Party | Learns |
|---|---|
| Payer / agent runtime | "a verified human" + one-time destination |
| Issuer | one nullifier per human; nothing about payments |
| Relay | timing + ciphertext sizes |
| Nearby enrolled phones | the probe embedding (sealed to them; discarded after compare) — **known leak, disclose it** |
| Chain (lite) | an amount went to a fresh address |
| Chain (full) | a Railgun transaction happened |
| RPC provider | the recipient's address lookups (sweeps/balance reads). **Disclose it.** Roadmap fix: Anon-RPC (a Sepolia network exists) |
| 0G (speech-to-text + intent) | the voice clip + intent text, inside a TEE (private mode, zero retention) |
| 0G (text-to-speech) | our template reply text (e.g. "Sure, I'll initiate a 2 USDC payment"). TTS models aren't offered in private mode, so it runs in standard/verified mode. **Disclose it.** The text contains the amount, never a name or address. |
| Chain observers | the agent wallet's payments. If it's funded from the payer's main wallet, they're linkable to the payer. **Disclose it.** Full mode fixes this. |

## Threats and answers (for judge Q&A)

- **Spoofed face (photo held up):** the payment can only go to the *owner* of that face, because only their phone matches.
- **Lying phone claims every probe:** collides with the real owner → abort. Each card costs a real World ID, so sybil claimants are expensive. Spend caps limit losses. Future work: private fuzzy matching.
- **Replay or address swap:** the proof is bound to nonce + destination + chain + token + amount.
- **Stolen card:** someone who copies `s` and σ off a phone can act as that holder. Mitigation: device-bound storage. Disclose it.
- **0G down:** safe-stop. The OLED shows "BRAIN OFFLINE - PAUSED". No fallback decisions. (If TTS is down but intent works, the OLED still shows everything; voice is a convenience, not a gate.)
- **Agent goes rogue / prompt injection via voice:**
  - the LLM only returns `{amount, token}`, which is validated by zod; it can't choose a destination or touch the key
  - deterministic caps apply; over cap needs a fresh World Agent Pass
  - every payment needs a physical CONFIRM
  - the worst case is bounded by the agent wallet's balance
- **Agent runtime machine compromised:** the attacker gets the agent wallet's budget, not the main wallet. Keep it topped up only to the daily cap. Roadmap: on-chain spend limits through a smart account (e.g. a session key with an allowance).

## Hardware notes

- ESP32-S3 (XIAO Sense or similar) + OV2640, SSD1306 128×64 I²C OLED, buttons: CAPTURE (push-to-talk) / CONFIRM / CANCEL.
- **Voice goes through Bluetooth earbuds paired to the payer laptop**, not a glasses mic. The browser records the earbud mic and plays the 0G TTS reply. An I²S mic on the glasses is optional (backup only).
- Firmware: CAPTURE press → JPEG → POST to the bridge, and a button-down/up event, so the browser knows when to record. The bridge pushes OLED text back (HTTP or WebSocket).
- Package it as `@cpay/glasses-kit` (firmware + bridge). "Plug and play if hardware is present" is a 0G judging point.

## Implementation notes (decisions already made)

**Stealth (`packages/stealth`)**
- Use `@scopelift/stealth-address-sdk` (scheme 1, secp256k1). Don't hand-roll EC maths.
- Keys: `generateKeysFromSignature(walletSig)` over a fixed `KEY_DERIVATION_MESSAGE`, which warns the user never to sign it elsewhere. The meta-address URI is `st:eth:0x<spendPub><viewPub>`.
- **The recipient generates each destination itself**: `generateStealthAddress` with its OWN meta-address and a random ephemeral key. It stores `{address, ephemeralPublicKey, viewTag}` locally.
  - The payer never sees the meta-address.
  - No on-chain `Announcement` is needed.
- Recover the spend key with `computeStealthKey`. Assert that `privateKeyToAccount(pk).address` equals the destination.
- Self-check with `checkStealthAddress`.
- Pay = ERC-20 `transfer` + a separate small ETH **gas drop** (~0.0003 ETH on Sepolia), so the one-time address can move funds later without being funded from a known wallet.
- Sweep = transfer the full balance out using the gas drop.
- Gotcha: the SDK's ESM build uses directory imports, which Node's ESM loader rejects. In vitest, set `test.server.deps.inline: ["@scopelift/stealth-address-sdk"]`. `tsx` and Next handle it fine.

**Sealing (`packages/protocol`)**
- X25519 (`@noble/curves`) → HKDF-SHA256 (`@noble/hashes`) with info `cpay/v1/<context>` → AES-256-GCM (`@noble/ciphers`) with a 12-byte random IV and the context as AAD.
- Contexts: `probe:<sessionId>`, `claim:<sessionId>`.
- Recipients rotate their X25519 key per relay connection. Payers use a fresh key per session.

**Binding digest**
- `sha256("cpay/v1/binding" ‖ lp(sessionNonce) ‖ lp(lower(destination)) ‖ lp(chainId) ‖ lp(lower(token)) ‖ lp(amount))`
- `lp(x)` = 4-byte big-endian length prefix + UTF-8 bytes.
- This is the BBS presentation header. Tests must show that changing any field breaks verification.

**Relay wire protocol** (zod-validated, max payload 256 KB)
- client → relay:
  - `recipient.hello{pub}`
  - `payer.hello`
  - `probe{sessionId(uuid), payerPub, items[{peerId, box{iv,ct}}]}`
  - `claim{sessionId, box}`
- relay → client:
  - `peers{peers[{peerId, pub}]}` (in reply to `payer.hello`)
  - `probe{sessionId, payerPub, box}` (one per recipient)
  - `claim{sessionId, box}` (routed to the session owner)
  - `error{message}`
- The relay maps sessionId → payer socket, caps open sessions per payer, and forgets everything on close. It never says who sent a claim, so the payer **trial-decrypts** each claim against the peers it probed. That also tells the payer which peer answered, so it can detect more than one responder.
- Sealed bodies:
  - `ProbeBody{v:1, sessionNonce(32-byte hex), embedding(base64 Float32), chainId, token, amount(base units), mode: lite|full}`
  - `ClaimBody{v:1, sessionNonce, destination, credentialProof}`
- The payer rejects a claim whose nonce doesn't match its session.

**Face matching**
- Cosine similarity.
- Template = L2-normalised mean of 5+ enrolment embeddings.
- Default threshold 0.6 until calibrated on the team. A false accept pays the wrong person; a false reject just falls back to QR.
- Same model and preprocessing on both sides. Reject an embedding-length mismatch.

**0G (`packages/zerog`)**
- Use `fetch` against `https://router-api.0g.ai/v1`, with `Authorization: Bearer $ZG_ROUTER_API_KEY` and `X-0G-Provider-Trust-Mode: private` on every call.
- `transcribe(audio)` → `POST /audio/transcriptions` with `whisper-large-v3`.
- `parseIntent(text)` → `POST /chat/completions` with `glm-5.3`. The output is validated with zod (`{amount, token, mode}`). Anything that doesn't parse is a refusal, not a guess.
- Capture the request ID from the `X-Request-ID` header, falling back to `x_0g_trace.request_id`. **A missing request ID counts as a failure.**
- Safe-stop: a network error, non-2xx, timeout (~8 s) or missing request ID throws `ZeroGUnavailable`. The UI and OLED show `BRAIN OFFLINE - PAUSED`.
- `speak(text)` → `POST /audio/speech` (TTS model from `GET /v1/models` `speech_capabilities`, e.g. a `minimax-speech-*-turbo`, `response_format: mp3`) → audio bytes + request ID.
  - `text` is always one of our fixed templates, filled with validated numbers. **Never** LLM output, a name or an address.
  - TTS is not private-mode; see "Who learns what".
- `logEpisode(episode)` → encrypt with the episode key (AES-GCM) → 0G Storage upload → `{rootHash, txHash}`.

**Agent wallet + runtime (`apps/web/app/api/pay`, using `@cpay/stealth`)**
- An EOA whose key is `AGENT_WALLET_PRIVATE_KEY`, read only by server code. It is never `NEXT_PUBLIC_*`, never in a prompt, never logged.
- The payer funds it with a small budget (USDC + Sepolia ETH). The balance is the hard ceiling. The main wallet is never connected to the agent.
- `POST /api/pay` is the **only** place that signs. It re-checks everything server-side, never trusting the browser:
  1. zod-validate the body
  2. verify the BBS proof against the issuer key and the recomputed `bindingDigest({sessionNonce, destination, chainId, token, amount})`
  3. policy: token allow-list, `amount <= PAYMENT_CAP` or a valid single-use Agent Pass approval for exactly this `{sessionId, amount, token}`, `spentToday + amount <= DAILY_CAP` (over the daily cap also needs Agent Pass), balance check
  4. physical confirm received for this session
  5. sign + send USDC transfer + gas drop
  6. record `spentToday`
- Spent-today ledger: a small local file/SQLite on the payer laptop (it's the payer's own data, not our backend's).
- Agent Pass approvals: kept in server memory, single-use, expire after ~5 min.

**Issuer (`apps/issuer`)**
- Hono + `better-sqlite3`. Table: `nullifiers(nullifier TEXT, action TEXT, created_at, UNIQUE(nullifier, action))`, with the nullifier stored as the normalised decimal of the uint256.
- Verify: forward the IDKit result unchanged to `POST https://developer.world.org/api/v4/verify/{rp_id}`, require `success`, require `environment` == `WORLD_ENVIRONMENT`, require signal == `hash(C)`.
- No request logging beyond method + path + status.

**Web app**
- Next.js with `transpilePackages` for workspace packages.
- `webpack.resolve.extensionAlias = {".js": [".ts", ".tsx", ".js"]}`, because workspace TS uses `.js` import specifiers.
- `experiments.asyncWebAssembly = true` for BBS and ONNX.
- Runs on port 3000. If the Next version defaults to Turbopack, run dev and build with `--webpack` (see `docs/STACK.md`).
- Phones need HTTPS for the camera, so `/receive` is served from the deployed URL or an HTTPS tunnel.

**Testing bar**
- An end-to-end relay test with 3 recipients: only the person being looked at replies; the payer opens exactly one claim; the destination belongs to that recipient and not the others.
