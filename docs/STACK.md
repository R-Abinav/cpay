# Tech stack

Boring, well-documented tools; no contracts; every user key on the phone.

## At a glance

| Layer | Choice | Lives in |
|---|---|---|
| Language / repo | TypeScript (ESM, strict), pnpm 12 workspaces, Node 22+, vitest, zod | root |
| App | Next.js (App Router, webpack build) + React + Tailwind, **installable PWA** | `apps/web` |
| On-device wallet | WebAuthn passkey **PRF** → HKDF (`@noble/hashes`) → keys; `viem` local account signs; IndexedDB + WebCrypto for storage | `packages/wallet` |
| Server API | Next route handlers (0G proxy, Agent Pass, episode upload, evidence) | `apps/web/app/api` |
| Glasses hub | Node + `ws` | `packages/glasses-kit/hub` |
| Relay | Node + `ws`, in memory | `apps/relay` |
| Issuer | Hono on Node | `apps/issuer` |
| Database | **Supabase (Postgres)**, server-side only, via `DATABASE_URL` + the `postgres` client | 3 tables |
| Chain | `viem` on **Base Sepolia** (chain 84532), Circle USDC | `packages/wallet`, `packages/stealth` |
| Credentials | `@docknetwork/crypto-wasm-ts` (BBS, blind issuance) | `packages/credential` |
| World | `@worldcoin/idkit` 4.x (headless hooks), `@worldcoin/idkit-core/signing`, `oauth4webapi` | `packages/world` |
| 0G | fetch router client; `@0gfoundation/0g-storage-ts-sdk` + `ethers` v6 | `packages/zerog` |
| Glasses firmware | PlatformIO (Arduino core): ESP32-CAM + ESP32-C3 SuperMini, WiFiManager captive portal, WebSocket over TLS | `packages/glasses-kit/firmware` |
| Hosting | **Render** (4 web services) + Supabase | `render.yaml` |
| Contracts | **None** | — |

## Deployment (Render) — required for finalists

| Render service | Code | Type | Health |
|---|---|---|---|
| `cpay-web` | `apps/web` (`next start`) | Web Service | `/api/health` |
| `cpay-hub` | `packages/glasses-kit` (`hub`) | Web Service (WebSockets) | `/health` |
| `cpay-relay` | `apps/relay` | Web Service (WebSockets) | `/health` |
| `cpay-issuer` | `apps/issuer` | Web Service | `/health` |

- Defined in a root `render.yaml` Blueprint. Each owner edits only their service block (`docs/TEAM.md`).
- **Free plan + keep-alive:** free instances sleep after 15 min without traffic, which drops the glasses' sockets. An external cron hits every `/health` **every 14 min**. Free plan gives 750 instance-hours per month per workspace; 4 always-awake services use ~96 h/day, enough for the hackathon week. Move `cpay-hub` to a paid instance if we keep running after.
- Free instances have no persistent disk. Nothing needs one: all persistent state is in Supabase.
- Secrets are Render environment variables (never in `render.yaml`).
- Logs: Render keeps service logs. Our logs contain method/path/status, counts and 0G evidence lines only (invariant 3).

**Local testing:** run services with `pnpm web|hub|relay|issuer`; expose them with ngrok/cloudflared. **Passkeys are bound to the domain (`rpId`):** a wallet created on a tunnel domain won't open on the Render domain. Use one fixed tunnel domain for testing, and treat wallets made there as throwaway. Final `rpId` = the production `cpay-web` domain.

## Supabase (Postgres)

Used only as Postgres. Rules:
- **Server-side only.** Services connect with `DATABASE_URL` (Supabase pooled connection string). No Supabase SDK or key in the browser, ever.
- **RLS enabled on every table with no policies**, so the auto-generated public API (anon key) can read and write nothing.
- **Don't use** Supabase Auth, Storage, Realtime or Edge Functions.
- Migrations as SQL files in each owning service (`apps/issuer/migrations`, `packages/glasses-kit/hub/migrations`, `apps/web/migrations`).
- CROPS "C" line: "Supabase holds only nullifiers, glasses pairings and 0G request IDs. If it disappears, existing cards and wallets keep working; new sign-ups and pairings stop. It's plain Postgres, so anyone can self-host it."

```sql
-- issuer
create table nullifiers (
  nullifier       text not null,   -- normalised decimal of the uint256
  action          text not null,
  commitment_hash text not null,   -- sha256 of the blind commitment; allows same-holder re-issue only
  unique (nullifier, action)
);
-- hub
create table glasses_units (
  unit_id          text primary key,
  unit_secret_hash text not null,
  owner_token_hash text            -- null = unpaired
);
-- web (0G proof for judges; no user data)
create table zg_evidence (
  id bigserial primary key,
  ts timestamptz not null default now(),
  kind text not null,              -- transcribe | intent | speak | storage
  model text, trust_mode text, http_status int, latency_ms int,
  request_id text, client_request_id text,
  receipt jsonb, raw_trace jsonb, raw_zg_headers jsonb,
  root_hash text, storage_tx_hash text, request_ids text[], error text
);
alter table nullifiers enable row level security;
alter table glasses_units enable row level security;
alter table zg_evidence enable row level security;
```
No timestamps on `nullifiers` or `glasses_units` (they'd only add linkable metadata). `zg_evidence` never stores audio, transcripts, intent text, addresses, IPs or ticket IDs.

## The PWA (`apps/web`)

- Pages: `/` Wallet, `/pay`, `/receive`, `/activity`, `/settings`, `/onboarding`, `/evidence` (details in `ARCHITECTURE.md`).
- **Pay unlocks only while the user's paired glasses are online.** Otherwise the Pay tab shows "Glasses disconnected · receive only".
- HTTPS everywhere (camera, mic, passkeys). Earbuds pair with the **phone**; the PWA records the mic and plays TTS audio.
- QR decoding: `jsQR` on the phone, from hub frames.
- Self-host everything: models, WASM, fonts. No analytics, no trackers, no CDNs.
- Next config: `transpilePackages` for `@cpay/*`, `webpack.resolve.extensionAlias = {".js": [".ts", ".tsx", ".js"]}`, `experiments.asyncWebAssembly = true`, `next build --webpack`.

## Server API (`apps/web/app/api`)

| Route | Does | Notes |
|---|---|---|
| `POST /api/intent` | audio → 0G STT → intent → `{amount, token}` or refusal, + evidence | needs a valid hub ticket; rate-limited per ticket; never logs or stores audio/text |
| `POST /api/speak` | template id + numbers → 0G TTS → mp3 | text must be a `replyText()` template |
| `POST /api/episode` | **ciphertext** from the phone → 0G Storage → rootHash, + evidence | never sees plaintext |
| `GET /api/agent-pass/start`, `/callback`, `/status` | World Agent Pass OIDC (`link` / `approve`) → signed approval token | client secret + approval key server-side |
| `GET /api/evidence` | public list of `zg_evidence` rows | for 0G judges |
| `GET /api/health` | keep-alive | |

Server keys here are **ours**, never a user's: 0G router key (credits), 0G Storage key (upload gas), Agent Pass client secret, Agent Pass approval signing key, hub ticket secret.

## Agent wallet (per user, on the phone)

- A plain Base Sepolia EOA derived from the user's passkey (`cpay/v1/agent-wallet`). Signed on the phone with `viem`.
- The user funds it with a small budget. **The balance is the hard ceiling.** The user's main wallet never connects.
- Caps are off-chain, in `packages/wallet` on the phone: per-payment, daily, token allow-list, balance; over a cap → Agent Pass approval token.
- Roadmap: a smart account with on-chain session-key limits (ERC-4337/7710), so caps hold even if the app is modified.

## Contracts: none, on purpose
- CPay QR / face: USDC `transfer` + ETH gas drop to a recipient-generated one-time EOA. Plain QR: USDC `transfer`.
- "Contract addresses" for the submission = Circle USDC on Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## 0G specifics (verified 5 Nov 2026)

- **Router:** `https://router-api.0g.ai/v1`, `Authorization: Bearer sk-…` (our 0G credits pay for every user for now; per-user 0G accounts via iAI sign-in are roadmap).
  - `POST /v1/audio/transcriptions` (ears), `POST /v1/chat/completions` (brain), `POST /v1/audio/speech` (voice).
- **Trust mode:** header `X-0G-Provider-Trust-Mode: private | verified | standard`.
  - **Models are chosen by the teammate** via `ZG_STT_MODEL`, `ZG_INTENT_MODEL`, `ZG_TTS_MODEL` (+ per-kind trust-mode vars).
  - Facts from `GET /v1/providers` on 5 Nov, to help choose: `whisper-large-v3` has a private provider. **`glm-5.3` has only `verified` providers (no private).** `0gm-1.0-35b-a3b` is private and supports `response_format`. TTS models (`minimax-speech-*`) are `standard` only. **Our "private inference" claim is only true for models with a private provider**; re-check before the demo.
- **TTS:** body `{model, input, voice, response_format: "mp3", speed}` (extra fields → 400); voices from `GET /v1/models` → `speech_capabilities.voices`. Only fixed template text is ever sent.
- **Request ID:** `X-Request-ID` header, fallback `x_0g_trace.request_id`.
- **Receipt:** the response's `ZG-Res-Key` header is the provider's response id; the signed receipt is fetched from the provider's `/v1/proxy/signature/{key}` and verified against its on-chain TEE signer (`github.com/0gfoundation/0g-pc-e2ee` `protocol/SPEC.md` §8). `x_0g_trace.tee_verified` is the router's own verdict when the request sends `verify_tee: true`. Ask at the 0G booth which artifact they want to see; keep everything until then.
- **Storage:** EVM RPC `https://evmrpc-testnet.0g.ai`, indexer `https://indexer-storage-testnet-turbo.0g.ai`; `merkleTree()` before upload; keep the root hash.

### 0G evidence (VERY IMPORTANT: 0G asked to be shown request IDs + receipts)
- Every 0G call (transcribe, intent, speak, storage upload) produces an evidence record, **including failures where 0G answered**:
  `{ts, kind, model, trustMode, httpStatus, latencyMs, requestId, clientRequestId, receipt, rawTrace, rawZgHeaders, rootHash?, storageTxHash?, requestIds?, error?}`
- It's kept in three places:
  1. **Server log line:** `[0g] kind=intent model=… requestId=… receipt=…|missing`
  2. **`zg_evidence` table** (persistent; Render's disk isn't) → the public `/evidence` page
  3. **The user's phone:** the activity entry and the encrypted episode on 0G Storage
- `packages/zerog/EVIDENCE.md` collects real IDs, receipts and root hashes for the README.
- Never in evidence or logs: audio, transcript, intent text, addresses, IPs, ticket IDs.

## Environment variables (by service)

See `.env.example` for the full list with comments. Summary:

| Service | Secrets | Public / config |
|---|---|---|
| `cpay-web` | `ZG_ROUTER_API_KEY`, `ZG_STORAGE_PRIVATE_KEY`, `AGENT_PASS_CLIENT_SECRET`, `AGENT_PASS_APPROVAL_SECRET_KEY`, `HUB_TICKET_SECRET`, `DATABASE_URL` | `ZG_*` models/modes, `AGENT_PASS_ISSUER/CLIENT_ID/REDIRECT_URI/ACR`, all `NEXT_PUBLIC_*` |
| `cpay-hub` | `HUB_TICKET_SECRET`, `DATABASE_URL` | `HUB_PORT`, `HUB_ALLOWED_ORIGINS` |
| `cpay-relay` | — | `RELAY_PORT` |
| `cpay-issuer` | `WORLD_RP_SIGNING_KEY`, `ISSUER_BBS_SECRET_KEY`, `DATABASE_URL` | `WORLD_RP_ID`, `WORLD_ENVIRONMENT`, `WORLD_ACTION`, `ISSUER_ALLOWED_ORIGINS` |
