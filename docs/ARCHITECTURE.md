# CPay architecture

The design rule behind everything here: **servers hold nothing that identifies a user or moves their money.** Keys live on the phone; servers route, verify and proxy, then forget. Read `CLAUDE.md` "Privacy comes first" before changing anything below.

## Components

| Component | Runs on | Holds | Never holds |
|---|---|---|---|
| **PWA wallet** (`apps/web`) | every user's phone (installable) | passkey-derived keys (agent wallet, stealth, BBS holder secret, episode key), BBS card, policy settings + spent-today ledger, one-time addresses handed out, activity (all encrypted in IndexedDB) | anything about other people |
| Glasses (one ESP32-CAM driving the OLED; a DevKit only supplies USB power) | the payer's head | camera, OLED; a unit ID + unit secret. **No buttons** | identities, wallet keys |
| Earbuds | the payer's ears, paired to **their phone** | mic + speaker | anything |
| **Glasses hub** (`packages/glasses-kit` hub, Render `cpay-hub`) | our server | live sockets for glasses + phones; `glasses_units` rows | frames (memory only, dropped), keys, wallets |
| **Relay** (`apps/relay`, Render `cpay-relay`) | our server (anyone can run one) | per-connection ephemeral pubkeys, ciphertext in flight | everything else |
| **Issuer** (`apps/issuer`, Render `cpay-issuer`) | our server | World RP signing key, BBS issuer secret key, `nullifiers` rows | faces, wallets, payments, IPs |
| **Web API** (`apps/web/app/api/*`, Render `cpay-web`) | our server | 0G router key, 0G Storage key, Agent Pass client secret + approval signing key, `zg_evidence` rows | user keys, audio/text after the request ends, payment data |
| Supabase (Postgres) | managed | the three tables in `CLAUDE.md` invariant 3 | anything else |
| 0G router (Private Computer) | 0G | speech-to-text + intent in **private** mode (TEE, zero retention); TTS of template text | keys, faces |
| 0G Storage | 0G | episode logs **encrypted on the phone** | plaintext |
| Base Sepolia (chain 84532) | chain | USDC transfers | links to identities (beyond what addresses reveal) |

## (0) Onboarding, once per person (~60 s)

1. Open the PWA (install it). Tap **Create wallet**.
2. **Passkey with PRF** (WebAuthn):
   - `navigator.credentials.create()` with `extensions: {prf: {}}` and the app's fixed `rpId`; then `get()` with `extensions: {prf: {eval: {first: SALT}}}`, `SALT = sha256("cpay/v1/root")`.
   - The 32-byte PRF output is the **root secret**. It never leaves the device and is never stored; we re-derive it with a passkey prompt when needed, and keep derived keys wrapped by a non-extractable WebCrypto key in IndexedDB for the session.
   - Synced passkeys (iCloud Keychain, Google Password Manager) give the same root on the user's other devices: that's the backup.
   - **Fallback** if the browser has no PRF: a random 32-byte root in IndexedDB (wrapped by a non-extractable key) + "Export encrypted backup" (passphrase → scrypt from `@noble/hashes` → AES-GCM). Disclose that this mode loses funds if the phone is lost without a backup.
3. **Derive every key** with HKDF-SHA256 (`@noble/hashes`) from the root, one `info` string each:
   - `cpay/v1/agent-wallet` → secp256k1 private key → the **agent wallet** (a plain EOA)
   - `cpay/v1/stealth-spend`, `cpay/v1/stealth-view` → stealth spending/viewing keys
   - `cpay/v1/bbs-holder`, `cpay/v1/bbs-blinding` → BBS holder secret `s` and the commitment blinding (deterministic, so re-enrolment reproduces the same commitment)
   - `cpay/v1/episode` → AES-256-GCM key for 0G episode logs
   - Map derived bytes into valid key ranges with the libraries' own helpers (reduce mod n, reject zero); don't hand-roll curve maths.
4. **Verify human (World IDKit 4, Proof of Human)**, action `cpay-recipient-v1`, signal = `commitmentSignal(C)` where `C` is the blind commitment to `[s, blinding]`.
   - The issuer verifies with World, stores `(nullifier, action, sha256(C))`, blind-signs `[s (hidden), tier=orb, epoch=YYYY-MM, blinding (hidden)]`, returns σ. The phone verifies σ and stores the card.
   - **Re-enrolment** (new phone, same passkey): the same World ID gives the same nullifier, and the same passkey gives the same `C`. If `sha256(C)` matches the stored row, the issuer re-signs (same holder, no extra sybil power). A different `C` for a used nullifier is rejected.
   - Needed to receive via **CPay QR** (private + verified). Receiving on a plain address needs no World ID.
5. **Link World for Agent Pass** (once): run Agent Pass in "link" mode. The phone stores `sha256(sub)` from the validated ID token. Later approvals must carry the same `sub` hash, so a stolen unlocked phone can't approve over-cap payments with someone else's World ID. The server stores nothing.
6. **Fund the agent wallet**: Wallet shows its address as a QR. Top it up with Base Sepolia USDC + a little Base Sepolia ETH from any wallet or faucet. **The balance is the hard ceiling of what the agent can ever spend.**

## (1) Pairing glasses, once

- The ESP32-CAM is the **glasses unit** (one board: camera + OLED). At flash time, `glasses-kit provision` writes a `unit_id` + random `unit_secret` into its NVS (like a factory). Wi-Fi is set later through a captive portal (`docs/HARDWARE.md`).
- The board connects to `wss://<hub>/device` and authenticate with a challenge–response HMAC over `unit_secret`. First contact registers `(unit_id, sha256(unit_secret))` (trust on first use).
- **Unpaired:** the hub sends the unit a random **6-character pairing code** (valid 5 min, single use); the OLED shows it.
- In the PWA, Settings → **Pair glasses** → type the code. The phone generates a random `owner_token` (kept on the phone) and sends it with the code. The hub stores `sha256(owner_token)` on the unit row.
- From then on the phone connects to `wss://<hub>/phone` with its `owner_token`; the hub routes **only** between that unit and that phone. Unpairing clears the hash. Many units and phones are served at once.
- The hub also issues the phone a short-lived **hub ticket** (HMAC with `HUB_TICKET_SECRET`, a random ticket ID + expiry, no unit ID inside) that `cpay-web` checks before spending 0G credits. Only people with paired glasses can use the voice agent, and it's rate-limited per ticket.

## (2) Paying (QR first; face is a stretch goal)

```
Pay tab: enabled only while the hub reports YOUR unit online; else "Glasses disconnected · receive only"
No buttons on the glasses. The phone drives the session; the OLED + earbuds are the hands-free interface.

SCAN
TAP "Scan" (phone) --scan{on}--> hub --stream{on, QVGA 320x240, ~5 fps}--> CAM; OLED "SCANNING"
CAM frames (software JPEG) --hub (memory only)--> phone: live feed + jsQR on EVERY frame, ON THE PHONE; dropped after decode
  valid wallet QR -> phone: scan{off} at once (camera off), beep, OLED "<label> / 0xAB..12"
       CPay QR   -> recipient = {peerId, pub} on the relay       label "VERIFIED HUMAN" (after the claim verifies)
       plain/681 -> recipient = public address                   label "PUBLIC ADDR · not verified"
  not a wallet QR -> keep scanning; if it's the only QR seen: "NOT A WALLET QR"; other chain -> "WRONG NETWORK"
  10 s with no valid QR -> camera off, OLED "NO QR - TAP TO RETRY", voice "No QR found"
       camera stays on 3 s more so the user can re-aim; one tap = a new 10 s scan
  Hub safety: the stream never runs > 15 s without a fresh scan{on}; phone "Stop" cancels anytime.

AMOUNT
after the beep, phone records the earbud mic until silence (VAD on the phone) or 6 s
phone --(audio, hub ticket)--> /api/intent --> 0G STT + intent (private mode)
       <-- {amount, token} | refused, + evidence (request IDs, receipts); evidence stored in zg_evidence
       refused/invalid -> "SAY AMOUNT AGAIN" + voice, mic reopens once; second miss -> "TAP TO RETRY"
       0G unreachable  -> safe-stop: OLED "BRAIN OFFLINE - PAUSED", voice if possible, nothing happens
phone --/api/speak(template "ack")--> 0G TTS --> earbuds: "Sure, I'll initiate a 2 USDC payment."

VERIFY (CPay QR only)
  phone --probe{sessionId, payerPub, items:[{peerId, sealed QrProbeBody{sessionNonce, chainId, token, amount}}]}--> relay --> that recipient
  recipient phone: createOneTimeDestination + BBS prove(bindingDigest) --claim--> relay --> payer
  payer: open claim, check nonce, verifyProof(issuer key, recomputed bindingDigest); no valid claim in 6 s -> "NO VERIFIED RECIPIENT"
  EIP-681 amount present and != voice amount -> stop ("Amount doesn't match the QR")

POLICY (packages/wallet, on the phone): token allow-list, per-payment cap, daily cap (local ledger), balance
  over a cap -> OLED "APPROVE ON PHONE" + voice -> World Agent Pass (/api/agent-pass/start with binding)
             -> server validates OIDC -> returns approval token signed by AGENT_PASS_APPROVAL key
             -> phone checks signature, binding {sessionId, amount, token, to}, sub hash == linked, unused jti, not expired
             -> denied/cancelled/expired: voice "Approval denied, nothing was paid."

CONFIRM (spoken, with a one-time code)
phone: code = random 10..99 (crypto.getRandomValues), new for every payment, never reused
OLED "PAY 2 USDC / VERIFIED HUMAN (or 0xAB..12) / SAY CONFIRM 47"
voice (template) "Pay 2 USDC to a verified human? Say confirm 47."
phone records 5 s --(audio, hub ticket)--> /api/transcribe --> 0G STT (private) --> transcript (+ evidence)
phone code (deterministic, NOT an LLM): normalise (lowercase, digits <- number words)
  "confirm" + the exact code            -> CONFIRMED
  "cancel" / "stop" / "don't" / "no"    -> CANCELLED
  anything else, wrong code, silence    -> "SAY CONFIRM 47 AGAIN" once, then CANCELLED
  two failed voice tries                -> the phone shows a "Confirm" button (tap fallback)
  whole confirm step must finish within 60 s

PAY
phone signs with the agent wallet (viem local account) and sends via the Base Sepolia RPC:
  CPay QR: USDC transfer + ETH gas drop to the one-time address   plain: USDC transfer to the address
phone: ledger += amount; episode {decision, requestIds, receipts, policyResult, txHash, timestamps}
       -> AES-GCM with the episode key ON THE PHONE -> /api/episode (ciphertext only) -> 0G Storage -> rootHash
       -> evidence row {kind: storage, rootHash, requestIds}; activity entry stored on the phone
voice "Paid 2 USDC." OLED "PAID"
```

**Why a spoken code and not just "confirm":** a bare "confirm" could come from a bystander, a video, or the amount recording. The code is shown only on the wearer's OLED and changes every payment, so saying it proves the wearer saw and approved *this* payment. 0G only transcribes; code on the phone decides.

**Face path (stretch, after QR works):** same stream; the phone embeds the centred face locally, then probes nearby enrolled phones through the relay with a sealed embedding (`ProbeBody`). Only the owner's phone matches and answers with the same claim as the CPay QR path. Everything else in the flow is identical. See "Implementation notes".

## (3) Receiving

- **Private (default): the CPay QR.** Receive connects to the relay, gets a `peerId`, and shows `cpay:1:<peerId>.<x25519PubHex>`. When a payer probes it, the phone answers automatically with a **fresh one-time address** and a BBS proof bound to that payment. The payer never sees anything stable. The QR changes with every relay connection.
- **Public: plain address QR.** EIP-681 for the user's **agent wallet** address, behind a "this reveals your wallet address to the payer" note.
- **Collecting private funds:** Wallet sums the one-time addresses (recovered keys on the phone). Spending from them directly keeps them unlinked. "Sweep to agent wallet" links them on-chain, so the button says so.
- **Invisible:** a toggle disconnects Receive from the relay.

## QR formats (parsed in `packages/wallet`)

| QR | Format | Pay as |
|---|---|---|
| CPay | `cpay:1:<peerId(uuid)>.<pub(64 hex)>` (short, so the glasses camera reads it reliably) | relay probe → verified claim → USDC + gas drop to a one-time address |
| EIP-681 | `ethereum:<0xaddress>[@84532][/transfer?address=<token>&uint256=<amount>]` | direct USDC transfer; chain must be absent or 84532 (anything else, incl. Base mainnet 8453 and Ethereum, is rejected); token must be allow-listed; QR amount must equal the spoken amount |
| Plain | `0x` + 40 hex (checksum-validated if mixed case) | direct USDC transfer |
| Anything else (UPI, URLs, text) | | rejected: "Unsupported QR" |

## Who learns what (README CROPS "P" line)

| Party | Learns |
|---|---|
| Payer | CPay QR: "a World-verified human" + a one-time address. Plain QR: the address the recipient showed |
| Recipient | an amount arrived at an address they control |
| Issuer | one nullifier + commitment hash per human; nothing about payments |
| Relay | timing + ciphertext sizes |
| Glasses hub | which unit is paired to which anonymous token; **the camera frames and button presses while you scan (memory only, not stored; not end-to-end encrypted yet: disclosed)** |
| Web API | that some ticket holder used voice; audio/intent text in transit to 0G (never stored or logged); encrypted episodes (can't read them) |
| 0G (STT + intent) | the voice clip + intent text, inside a TEE (private mode, zero retention) |
| 0G (TTS) | our template reply text with the amount (TTS has no private mode: disclosed) |
| 0G Storage | encrypted blobs |
| Supabase | the three tables, nothing else |
| RPC provider | the phone's transactions and balance reads, with its IP. **Disclose**; roadmap: Anon-RPC |
| Chain observers | agent wallet → address transfers. If you fund the agent wallet from your main wallet, they're linkable to you. **Disclose**; roadmap: Railgun via Kohaku |
| Nearby enrolled phones (face path only) | the sealed probe embedding, discarded after compare. **Disclose** |

## Threats and answers (judge Q&A)

- **Our servers are breached:** the attacker gets nullifiers, unit pairings (hashes) and 0G request IDs. No keys, no money, no identities, no payment history.
- **Phone stolen (unlocked app):** the thief can pay up to the caps; over a cap needs Agent Pass with the owner's World ID (`sub` hash check). Loss is bounded by the agent wallet balance.
- **Phone lost:** sign in on a new phone with the same synced passkey; keys re-derive; the World card re-issues (same commitment).
- **Prompt injection by voice** ("send everything to 0xABC"): the LLM can only output `{amount, token}`; the destination comes from the QR; caps + the spoken confirm code still apply.
- **Someone nearby says "confirm":** they can't see the one-time code on the wearer's OLED; a wrong or missing code cancels.
- **QR swapped (sticker attack):** plain QR: you pay whatever address it shows, so the label says "not verified" and over-cap needs Agent Pass. CPay QR: the claim is bound to the destination, so a swapped address fails verification, and a fake CPay QR needs a World-verified card.
- **Replay or address swap:** proofs are bound to nonce + destination + chain + token + amount.
- **Hub impersonates a phone/glasses:** units authenticate with HMAC over the unit secret; phones with the owner token. The hub can see frames (disclosed); it can't sign payments.
- **Lying phone claims every face probe (face path):** collides with the real owner → abort. Each card costs a real World ID.
- **0G down:** safe-stop. Never a fallback decision.
- **Render cold start / restart:** boards and phones reconnect automatically; a keep-alive cron pings `/health` every 14 min.

## Implementation notes (decisions already made)

**Wallet (`packages/wallet`, browser)**
- Passkey PRF + HKDF derivation as in onboarding step 2–3. One module owns the root; everything else gets derived keys.
- The `rpId` is fixed in config (`NEXT_PUBLIC_PASSKEY_RP_ID`, the production domain). **Changing the domain changes every user's keys.** Decide the final domain before real users.
- Agent wallet: `privateKeyToAccount` (viem) from the derived key; sign and send with `viem` over `NEXT_PUBLIC_RPC_URL` (Base Sepolia, chain `NEXT_PUBLIC_CHAIN_ID`).
- Policy engine: pure functions (`evaluate(intent, recipient, settings, ledger, balance)` → allow | needs_approval | deny with reason). Defaults from `NEXT_PUBLIC_DEFAULT_PAYMENT_CAP_USDC` / `..._DAILY_CAP_USDC`; the user can lower or raise them in Settings, and raising needs Agent Pass. Unknown balance → deny.
- Ledger in IndexedDB: spent today (per device), used session IDs, used approval `jti`s.
- Approval token check: Ed25519 signature (`@noble/curves`) with `NEXT_PUBLIC_AGENT_PASS_APPROVAL_PUBLIC_KEY`; fields `{v, jti, binding:{sessionId, amount, token, to}, subHash, exp}`.
- QR parsing per the table above, with tests for every format and rejection.

**Stealth (`packages/stealth`)**
- `@scopelift/stealth-address-sdk` (scheme 1, secp256k1). Add `keysFromSeed(spendKey, viewKey)` for passkey-derived keys; keep `keysFromSignature` for tests/fallback.
- **The recipient generates each destination itself** with its own meta-address and a random ephemeral key; it stores `{address, ephemeralPublicKey, viewTag}` locally. The payer never sees the meta-address. No on-chain announcement.
- `recoverSpendKey` asserts `privateKeyToAccount(pk).address === destination`.
- Pay = USDC `transfer` + a small ETH **gas drop** (~0.0003 ETH). `payToDestination` takes a viem `Account`, so it works with the phone's agent wallet unchanged.
- Gotcha: the SDK's ESM directory imports need `test.server.deps.inline` in vitest and `moduleResolution: Bundler` for types.

**Credential (`packages/credential`)**: BBS via `@docknetwork/crypto-wasm-ts` (`docs/DECISIONS.md` §10)
- Card messages: `[s, tier, epoch, blinding]`; `s` and `blinding` hidden, `tier` and `epoch` revealed. Blind issuance works (the issuer never sees `s`).
- Presentation: `bindingDigest` passed as the proof nonce. Verified in the browser (payer) and Node (tests).
- Add `holderCommitFromSeed(s, blinding)` so the commitment is reproducible from the passkey.
- **Must be tested in the browser build** (webpack + asyncWebAssembly), not only Node.

**Sealing + relay (`packages/protocol`, `apps/relay`)**
- X25519 → HKDF-SHA256 (info `cpay/v1/<context>`) → AES-256-GCM, 12-byte IV, context as AAD. Contexts `probe:<sessionId>`, `claim:<sessionId>`.
- Binding digest: `sha256("cpay/v1/binding" ‖ lp(sessionNonce) ‖ lp(lower(destination)) ‖ lp(chainId) ‖ lp(lower(token)) ‖ lp(amount))`, `lp` = 4-byte BE length + UTF-8.
- Wire: `recipient.hello{pub}`, `payer.hello`, `probe{sessionId, payerPub, items[{peerId, box}]}`, `claim{sessionId, box}`; relay → `peers`, `probe`, `claim`, `error`. 256 KB max; in memory only; claims are trial-decrypted by the payer.
- **New for CPay QR:** `QrProbeBody{v:1, kind:"qr", sessionNonce, chainId, token, amount}` (no embedding). The payer probes exactly the `peerId` from the QR and needs no `peers` list (don't call `payer.hello` for QR payments). The recipient answers QR probes addressed to it without face matching.
- `ProbeBody` (face) unchanged: `{v:1, sessionNonce, embedding, chainId, token, amount, mode}`.

**Face matching (stretch)**: cosine; template = L2-normalised mean of 5+ embeddings; threshold 0.6 until calibrated; models YuNet + SFace in `apps/web/public/models`.

**0G (`packages/zerog`)** — full rule in `docs/STACK.md` "0G specifics" + "0G evidence"
- `fetch` to `https://router-api.0g.ai/v1`, Bearer key, `X-0G-Provider-Trust-Mode` per call, `X-Client-Request-Id`.
- `transcribe`, `parseIntent` (strict JSON → zod; invalid → refusal, never a guess), `speak` (template text only), `ZeroGUnavailable` safe-stop.
- Models come from env (`ZG_STT_MODEL`, `ZG_INTENT_MODEL`, `ZG_TTS_MODEL`); **the teammate chooses them.** The private-mode claim only holds if the chosen model has a private provider (check `GET /v1/providers`).
- Evidence: request ID (`X-Request-ID` / `x_0g_trace.request_id`) + receipt (`ZG-Res-Key` → provider signature; `x_0g_trace.tee_verified`) + raw trace/headers, written through an injected sink (Supabase `zg_evidence` in prod, console always).
- **Episode encryption moves to the browser**: `encryptEpisode(episode, key)` with WebCrypto; the server-side `uploadEpisode(ciphertext)` only uploads bytes and records evidence. The server never sees plaintext episodes.

**Agent Pass (`packages/world` + `apps/web/app/api/agent-pass/*`)**
- OIDC with PKCE, `state`, `nonce`, `max_age=0`, essential `acr`; validate `iss`, signature, `state`, `nonce`, `acr`, `auth_time` (≤120 s). Sandbox issuer `https://sandbox.auth.world.org`, prod `https://auth.world.org` (env only).
- Modes: `link` (returns `sha256(sub)` to the phone once) and `approve` (returns a signed approval token for the binding). Pending attempts in memory, single-use, 5 min TTL. Nothing persisted.

**Issuer (`apps/issuer`)**
- Hono on Node; Postgres via `DATABASE_URL` (Supabase), `postgres` client. Table `nullifiers(nullifier text, action text, commitment_hash text, unique(nullifier, action))`, nullifier as the normalised decimal of the uint256.
- Verify: forward the IDKit result unchanged to `POST https://developer.world.org/api/v4/verify/{rp_id}`; require `success`, matching `environment`, signal == hash(C), Proof of Human, v4 only (legacy v3 refused: different nullifiers would allow two cards).
- Logs: method + path + status only.

**Glasses hub (`packages/glasses-kit/hub`)** — contract: `packages/glasses-kit/hub/src/messages.ts`
- `/device` (boards, HMAC auth) and `/phone` (owner token) WebSockets; `GET /health`.
- One device per unit (the ESP32-CAM). Device ↔ hub: `challenge`/`auth` (HMAC), `pair_code{code, exp}`, `paired`, `oled{lines}`, `stream{on, fps, size}`, binary JPEG frames, `status{rssi, heap, fps}`. **No buttons.**
- Phone ↔ hub: `auth{ownerToken}` / `pair{code, ownerToken}` → `hello{protocol:3, online}`, `device_status{online}`, `frame{seq, mime, dataBase64, ts}`, `ticket{token, exp}`, `error{code}`; phone → `scan{on}`, `oled{lines}`, `unpair`. The hub caps a stream at 15 s without a fresh `scan{on}`.
- Frames: forwarded and dropped; logs carry counts/sizes only.

**Web app (`apps/web`)**
- Pages: `/` Wallet (balance, glasses status, top-up QR), `/pay`, `/receive`, `/activity` (history + Privacy X-ray per payment + 0G evidence), `/settings` (pair glasses, caps, link World, backup), `/onboarding`, `/evidence` (public list of 0G request IDs/receipts/root hashes for judges; reads `zg_evidence`, no user data).
- PWA: `manifest.webmanifest`, icons, a service worker that caches only our own app shell. No third-party requests.
- API routes: `/api/intent`, `/api/transcribe` (STT only, for the confirm code), `/api/speak`, `/api/episode`, `/api/agent-pass/{start,callback,status}`, `/api/evidence`, `/api/health`. **No `/api/pay`: payments are signed on the phone.**
- Next config: `transpilePackages` for `@cpay/*`, `.js`→`.ts` `extensionAlias`, `asyncWebAssembly`, webpack build.
- Scan log panel on `/pay`: frames/s, drops, QR found (type, short address, chain), validation, policy result, tx hash link. Same lines to `console`. Never image data.

**Testing bar**
- `packages/wallet`: derivation is deterministic per root; QR parser accepts/rejects each format; policy cases incl. over-cap, daily cap, unknown balance, approval binding mismatch.
- Relay e2e: 3 recipients; CPay QR probe reaches only the addressed peer; face probe answered only by the match.
- Issuer: re-enrolment with the same commitment re-signs; a different commitment for a used nullifier is rejected.
- Hub: pairing code single-use + expiry; frames only reach the paired phone; logs contain no image data.
