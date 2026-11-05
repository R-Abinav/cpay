# Tech stack

Picked for one goal: **a working World + 0G demo by Fri 6 Nov 23:59 IST.** Boring, well-documented tools; no new chain code.

## At a glance

| Layer | Choice | Lives in |
|---|---|---|
| Language / repo | TypeScript (ESM, strict), pnpm workspaces, Node 22+ (24 LTS preferred), vitest, zod | root |
| Frontend | Next.js (App Router) + React + Tailwind CSS, installable PWA | `apps/web` |
| Agent runtime (payer-side server) | Next.js route handlers in `apps/web` (`app/api/*`). Holds the **agent wallet key**, the 0G key and the Agent Pass client secret | `apps/web/app/api` |
| Agent wallet | a plain Sepolia EOA with a small USDC + ETH budget, signed with `viem` | `.env` → `app/api/pay` |
| Voice I/O | Bluetooth earbuds paired to the payer laptop; browser `getUserMedia` (mic) + `<audio>` playback | `apps/web` `/pay` |
| Issuer backend | Hono on Node + SQLite (`better-sqlite3`) | `apps/issuer` |
| Relay | Node + `ws`, in memory only | `apps/relay` |
| Contracts | **None.** We deploy no Solidity (see below) | — |
| Chain client | `viem` on Ethereum Sepolia | `packages/stealth` |
| Glasses | ESP32-CAM (camera) + ESP32-C3 SuperMini (OLED + buttons), PlatformIO (Arduino core) + Node/TS bridge (`ws`) | `packages/glasses-kit` |

## Frontend (`apps/web`)

- **Next.js App Router, React, Tailwind.** Two routes:
  - `/receive` runs on the recipient's phone: onboarding, face enrolment, BBS card, answering probes.
  - `/pay` runs on the payer's laptop: the glasses feed, intent, policy, claim verification, the Privacy X-ray panel.
- **World:** `@worldcoin/idkit` 4.x (React widget). The RP signature comes from the issuer.
- **Face:** detection + embedding run in the browser.
  - Default: `onnxruntime-web` with a small face-embedding ONNX model.
  - **Check the model's licence** (InsightFace weights are non-commercial).
  - **Self-host every model/WASM file** in `public/`. No CDN, so nothing third-party sees the request (CROPS).
- **Chain:** `viem`. The recipient's stealth keys come from a wallet signature (injected EIP-1193 wallet).
- **Storage on device:** IndexedDB (face template, BBS card + holder secret, stealth keys). Encrypt it with a key from WebCrypto.
- **Config:**
  - `transpilePackages` for `@cpay/*`
  - `webpack.resolve.extensionAlias = {".js": [".ts", ".tsx", ".js"]}`
  - `experiments.asyncWebAssembly = true`
  - If the Next version defaults to Turbopack (Next 16+), run `next dev --webpack` / `next build --webpack`, or prove Turbopack resolves `.js` → `.ts` and loads WASM before switching.
- **HTTPS is required on phones.** `getUserMedia` (camera) only works in a secure context, so `/receive` must be served over HTTPS. That means a deployed URL or an HTTPS tunnel, not `http://<laptop-ip>:3000`.
- No analytics, no trackers, no Google Fonts from a CDN (use `next/font` with local files, or system fonts).

## Agent runtime (Next route handlers)

These run server-side, on the payer's laptop, so no secrets reach the browser. They are the **payer's own** agent, not our backend. The LLM is one input to it; the deterministic code here is what decides and signs.

| Route | Does | Talks to |
|---|---|---|
| `POST /api/intent` | earbud audio → `whisper-large-v3` → text → `glm-5.3` with a JSON-schema prompt → `{amount, token, mode}` + request IDs | 0G router, `X-0G-Provider-Trust-Mode: private` |
| `POST /api/speak` | template id + validated numbers → text → 0G TTS → mp3 for the earbuds | 0G router `POST /v1/audio/speech` (TTS isn't private-mode) |
| `POST /api/pay` | **the only signer.** Re-verifies the BBS proof + `bindingDigest`, re-runs policy (caps, allow-list, balance), checks the Agent Pass approval if over cap and the physical confirm, then the agent wallet sends USDC + gas drop | Sepolia RPC |
| `POST /api/episode` | encrypts the episode and uploads it to 0G Storage → root hash | 0G Storage (Galileo) |
| `GET /api/agent-pass/start`, `/callback` | World Agent Pass OIDC (PKCE, `max_age=0`, essential `acr`), validating `state`, `nonce`, `acr`, `auth_time` | `auth.world.org` |

Libraries: `@cpay/zerog` (fetch-based router client + `@0gfoundation/0g-storage-ts-sdk` + `ethers` v6), `@cpay/world` (`oauth4webapi` or `openid-client` for OIDC), `@cpay/credential` (proof verify), `@cpay/stealth` (pay).

Agent Pass is validated here and not in the issuer, so **the issuer never learns that a payment happened** (privacy invariant 3).

## Issuer backend (`apps/issuer`)

- **Hono** on Node.
- Endpoints:
  - `POST /rp-signature`: `signRequest` from `@worldcoin/idkit-core/signing`
  - `POST /enrol`: forward the IDKit payload to `POST https://developer.world.org/api/v4/verify/{rp_id}`, check `success` and `environment`, check signal == `hash(C)`, insert the nullifier, blind-sign
  - `GET /issuer-key`: the BBS public key
  - `GET /health`
- **SQLite** (`better-sqlite3`), one table:
  `nullifiers(nullifier TEXT NOT NULL, action TEXT NOT NULL, UNIQUE(nullifier, action))`.
  Store the nullifier as a normalised decimal string of the 256-bit value (World's guidance: treat it as a uint256, not as raw hex).
- **BBS:** `@docknetwork/crypto-wasm-ts` (BBS / BBS+ with blind signing; call `initializeWasm()` first).
  - Confirm its blind-sign + presentation-header API in step 1 of the identity work.
  - Fallback if blind issuance blocks: plain BBS issuance over `[s, tier, epoch]` where the issuer sees `s`. That's weaker (the issuer could impersonate a holder), so **disclose it in the README**.
- Logs: request method + status only. No IPs, no bodies.

## Relay (`apps/relay`)

Node + `ws`. Uses the zod wire schema from `@cpay/protocol`, a 256 KB max payload, and in-memory session maps. It persists nothing.

## Agent wallet

- **Every transfer comes from the agent wallet.** The payer's main wallet never connects to CPay; it only tops the agent wallet up.
- It's a plain EOA (`AGENT_WALLET_PRIVATE_KEY`) used by `app/api/pay` with `viem`. Fund it with roughly the daily cap in USDC + ~0.01 Sepolia ETH (gas + gas drops).
- Spend limits are enforced off-chain by the deterministic policy in `app/api/pay`:
  - per-payment cap (`AGENT_PAYMENT_CAP_USDC`)
  - daily cap (`AGENT_DAILY_CAP_USDC`)
  - token allow-list
  - over a cap → World Agent Pass
  - **the wallet balance is the hard ceiling**
- Roadmap: on-chain limits (a smart account with a session key + allowance) so even a compromised laptop can't exceed the cap. Not built this weekend: it adds contracts.

## Contracts: none, on purpose

- **Lite mode** is a plain ERC-20 `transfer` of Circle USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) plus an ETH gas drop to a **recipient-generated** one-time EOA.
- No `Announcement` and no registry are needed, so there's nothing to deploy or audit.
- In the submission, "contract addresses" = Circle USDC on Sepolia. We mention the ERC-5564 Announcer/Registry only as "exist, not needed".
- Full mode (Railgun via `@kohaku-eth/railgun`) is now **roadmap** (see `DECISIONS.md` §9).

## 0G specifics (verified 5 Nov 2026)

- **Router base URL:** `https://router-api.0g.ai/v1`, `Authorization: Bearer sk-…` (our 0G credits). Endpoints we use:
  - `POST /v1/audio/transcriptions` (ears)
  - `POST /v1/chat/completions` (brain)
  - `POST /v1/audio/speech` (voice)
- **TTS** (`/v1/audio/speech`):
  - body: `{model, input, voice, response_format: "mp3", speed}`; extra fields → 400
  - voices come from `GET /v1/models` → `speech_capabilities.voices`
  - candidates: `minimax-speech-2.8-turbo` / `-2.6-turbo`
  - **TTS models are not in private mode**, so we only send fixed template text with numbers, never names or addresses
- **Private mode:** the request header `X-0G-Provider-Trust-Mode: private` (or the body field `provider.trust_mode`).
  - Private-mode models: `whisper-large-v3` (speech) and `glm-5.3` (chat).
  - Also in private mode: `0gm-1.0-35b-a3b`, `vela-2.0-9b` (decision), `qwen3-embedding-*`.
- **Request ID:** the `X-Request-ID` response header, also in the body as `x_0g_trace.request_id`.
- **Receipts:** not documented in the router spec. Ask at the 0G booth; don't invent a field. Until then, keep the raw `x_0g_trace` + `x-0g-*` headers verbatim.
- **0G evidence (VERY IMPORTANT for the 0G prizes; 0G asked to be shown these):** every 0G call (transcribe, intent, TTS, storage upload) produces an evidence record, and we never drop one.
  - Record: `{ts, kind, model, trustMode, httpStatus, requestId, receipt, rawTrace, rawZgHeaders, rootHash?, txHash?}`
    - `requestId`: the `X-Request-ID` header, falling back to `x_0g_trace.request_id`
    - `receipt`: the signed receipt, **wherever 0G returns it** (field still to confirm at the 0G booth; verify with `github.com/0gfoundation/0g-pc-e2ee`)
    - until the receipt field is confirmed, also keep **verbatim** the whole `x_0g_trace` body object (`rawTrace`) and every `x-0g-*` response header (`rawZgHeaders`), so nothing 0G sends is lost
  - Stored in four places:
    1. **Console:** one server log line per call, `[0g] kind=intent model=glm-5.3 requestId=… receipt=…|missing`
    2. **Evidence file:** append-only JSONL at `ZG_EVIDENCE_PATH` on the payer laptop (git-ignored)
    3. **The episode on 0G Storage** (encrypted), plus a plaintext index `rootHash → requestIds` in the evidence file
    4. **UI:** the `/pay` screen and Privacy X-ray show the request IDs + receipt status for the current payment
  - `packages/zerog/EVIDENCE.md` collects the real IDs, receipts and root hashes for the README.
  - Privacy: evidence records hold IDs, receipts, model names and hashes only. **Never** the transcript, intent text, audio, faces or recipient addresses.
- **Storage:** EVM RPC `https://evmrpc-testnet.0g.ai`, indexer `https://indexer-storage-testnet-turbo.0g.ai`. Call `merkleTree()` before upload and keep the root hash.

## Hosting for the demo

| Thing | Where | Why |
|---|---|---|
| `apps/web` `/receive` | Vercel (public HTTPS) | phones need HTTPS for the camera; 0G wants a live link |
| `apps/web` `/pay` + agent runtime | `localhost:3000` on the payer laptop (holds the agent wallet key) | the key stays on the payer's machine; iAI sign-in only works on localhost. The public live link uses a separate low-balance **demo** agent wallet |
| `apps/issuer` | one small always-on host with a disk (Railway / Fly / a VPS) | SQLite needs a persistent volume |
| `apps/relay` | same host as the issuer, separate process, `wss://` | venue Wi-Fi often isolates clients, so a LAN relay is risky |
| bridge | payer laptop | talks to the glasses over Wi-Fi (phone hotspot) |

Everything is reproducible from the repo (`pnpm relay`, `pnpm issuer`, `pnpm web`) for the CROPS "O" line.
