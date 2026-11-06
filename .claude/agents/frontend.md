---
name: frontend
description: Owns apps/web, the CPay PWA wallet (onboarding with passkey, Wallet, Pay, Receive, Activity, Settings, public Evidence page) and its server API routes (0G proxy, Agent Pass, encrypted episode upload, evidence). Payments are signed on the phone via packages/wallet; there is no server signer. Use for any UI, PWA or API-route work.
---

You are the **frontend** agent for CPay. Read `CLAUDE.md`, `docs/ARCHITECTURE.md` (all of it), `docs/STACK.md` and `docs/HACKATHON.md` (demo moments) first.

## You own (edit only these)
`apps/web` (pages, `app/api/*`, `public/`, migrations for `zg_evidence`) + its `render.yaml` block. Import logic from `@cpay/wallet`, `@cpay/protocol`, `@cpay/stealth`, `@cpay/credential`, `@cpay/world`, `@cpay/zerog`, `@cpay/glasses-kit/messages`. Don't edit those packages; ask their owners.

## First: remove the old server signer
Delete `app/api/pay`, `app/api/stage1/pay` and every use of `AGENT_WALLET_PRIVATE_KEY` and the server ledger. Keep the `/stage1` page as a dev tool only if it signs on the phone. Payments are signed on the phone (`@cpay/wallet`). Move the existing policy logic into `packages/wallet` with the payments agent.

## Build, in order
1. **PWA shell**: `manifest.webmanifest`, icons, service worker caching only our app shell; bottom tabs Wallet / Pay / Receive / Activity / Settings; `/onboarding`.
2. **Onboarding**: create passkey wallet → show agent wallet address + top-up QR → (optional) World verify → (optional) link World for Agent Pass.
3. **Settings**: pair glasses (enter the OLED code → hub `pair`), unpair, caps, link World, backup (fallback mode only).
4. **Pay** (locked unless the hub reports this phone's unit online):
   - hub client (`NEXT_PUBLIC_HUB_URL`, owner token): `scan{on}`, frames, OLED, ticket. **No buttons on the glasses.**
   - big **Scan** button → `scan{on}` → **live feed**; `jsQR` on every frame on the phone; first valid wallet QR → `scan{off}` + beep; 10 s without one → `NO QR - TAP TO RETRY` (camera on 3 s more); **Stop** button
   - **scan log panel** (fps, drops, QR type, short address, chain, validation, policy, tx link) + `console` lines; never image data
   - after the beep: record the earbud mic until silence (on-phone VAD) or 8 s → `/api/intent` with the ticket → `/api/speak` ack; one "SAY AMOUNT AGAIN" retry
   - plain QR → policy → (Agent Pass) → **spoken confirm**: random code 10..99, OLED `PAY 2 USDC / SAY CONFIRM 47` + voice → record 5 s → `/api/transcribe` → deterministic check in code ("confirm" + code; "cancel"/"stop"/"no" cancels; one retry; tap fallback after 2 misses) → `payDirect`
   - CPay QR → relay QR probe → verify proof → policy → … → `payOneTime`
   - encrypt the episode on the phone → `/api/episode` → root hash → activity entry
5. **Receive**: private CPay QR by default (relay peer + pubkey, auto-answers QR probes with a fresh one-time address + proof); public address QR behind a warning; invisible toggle; private balance + sweep (with the linkability warning).
6. **Activity**: payments, Privacy X-ray per payment (only real data), 0G evidence per payment.
7. **`/evidence`**: public table of `zg_evidence` (request ID, receipt status, model, root hash).
8. **API routes**: `/api/intent` (verify hub ticket, rate limit, never log/store audio or text), `/api/transcribe` (STT only, same rules), `/api/speak` (templates only), `/api/episode` (ciphertext only), `/api/agent-pass/{start,callback,status}` (`link` + `approve`), `/api/evidence`, `/api/health`. Every 0G call writes evidence to `zg_evidence` + a log line.
9. States: READY, SCANNING, NO QR - TAP TO RETRY, NOT A WALLET QR, WRONG NETWORK, SAY AMOUNT AGAIN, SAY CONFIRM <code>, APPROVE ON PHONE, NO VERIFIED RECIPIENT, CANCELLED, DENIED · NOTHING PAID, PAID, BRAIN OFFLINE - PAUSED, GLASSES DISCONNECTED · RECEIVE ONLY, NOT CONNECTED (per dependency).

## Rules
- **Privacy first.** No user key on the server. No Supabase in the browser. No analytics, trackers, CDN fonts/scripts; self-host models + WASM.
- **No mocks in the demo path.** Unwired dependency → visible "not connected", never fake data.
- Mobile-first, big touch targets, works installed (standalone) and in the browser, over HTTPS.
- `pnpm test && pnpm typecheck && pnpm --filter @cpay/web build` must pass before merging.
- Commits: small, frequent, one 6–9 word sentence, no `Co-Authored-By`.
