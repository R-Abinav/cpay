# Team plan

Two humans, each running Claude Code (with parallel agents if useful). **Our deadline: Fri 6 Nov, 23:59 IST, fully submitted.**

> **Fri 6 Nov, early morning:** the teammate finished Stage 1 (`/stage1`: QR image upload → 0G intent → server agent wallet pays on Base Sepolia) and is away. Abinav runs every area with Claude Code agents on `abinav-hardware` until the teammate is back. Stage 1 proved 0G + Base Sepolia + USDC; its **server key** and **0G fallback** must go (rows below).

## Who owns what

| Owner | Areas (only edit these) | Branch |
|---|---|---|
| **Abinav** (hardware + 0G) | `packages/glasses-kit` (firmware, provisioning, **hub**), `packages/zerog`, the `cpay-hub` block in `render.yaml` | `abinav-hardware` |
| **Teammate** (software) | `apps/web`, `packages/wallet`, `packages/protocol`, `packages/stealth`, `apps/relay`, `apps/issuer`, `packages/credential`, `packages/world`, Supabase project + migrations for web/issuer, the other `render.yaml` blocks, the 0G **model choice** (env) | their own branch |
| Shared | `docs/`, `CLAUDE.md`, `README.md`, `AI_USAGE.md`, `.env.example`, root config | edit in small commits; tell the other person |

Agent definitions: `.claude/agents/{payments,identity,frontend}.md` (teammate), `{zerog,hardware}.md` (Abinav), `privacy-reviewer.md` (both, read-only).

## Contracts between the two of us
Change these only in their own commit, and message the other person first.

| Contract | Owner | Consumer | File |
|---|---|---|---|
| Hub ⇄ phone WebSocket messages (pairing, buttons, frames, OLED, stream, ticket) | Abinav | teammate (`apps/web`) | `packages/glasses-kit/hub/src/messages.ts` (zod, browser-safe) + `oledStates` helpers |
| Hub ticket format (checked by `/api/intent`) | Abinav | teammate | `packages/glasses-kit/hub/src/ticket.ts` (`verifyTicket(token, secret)`) |
| `@cpay/zerog` API (transcribe, parseIntent, speak, replyText, evidence sink, encryptEpisode, uploadEpisode) | Abinav | teammate (API routes, PWA) | `packages/zerog/src/index.ts` |
| Relay wire + `bindingDigest` + QR probe | teammate | both | `packages/protocol/src/*` |

## Where the code is today (merged on `abinav-hardware`, 208 tests green)
Built against the earlier "laptop payer" design. It's a head start, but these parts must change to match `docs/ARCHITECTURE.md`:

| Area | Keep | Change |
|---|---|---|
| `apps/web` | pages, face engine, policy logic, X-ray + evidence panels, Agent Pass routes | **delete `/api/pay` and every use of `AGENT_WALLET_PRIVATE_KEY`**; move policy + signing to `packages/wallet` on the phone; passkey onboarding; Wallet/Activity/Settings/Evidence pages; PWA manifest; hub client instead of the laptop bridge; QR scan + scan log + live feed |
| `packages/stealth` | everything | add `keysFromSeed` |
| `packages/protocol` | everything | add `QrProbeBody` + QR probe helpers |
| `apps/relay` | everything | `/health`; allow probing a peer without `payer.hello` |
| `apps/issuer` | World verify, BBS, endpoints, tests | SQLite → Supabase Postgres; `commitment_hash` + same-commitment re-issue |
| `packages/credential` | everything | `holderCommitFromSeed`; browser test |
| `packages/world` | IDKit + Agent Pass validation | `link` mode (`sub` hash); Ed25519 approval tokens |
| `packages/zerog` | client, evidence, safe-stop, smoke | evidence sink (Supabase), browser `encryptEpisode`, ciphertext-only `uploadEpisode`, models from env only |
| `packages/glasses-kit` | firmware structure, pin probes, message style | laptop bridge → **Render hub** (wss, pairing, unit auth, tickets, Supabase), burst streaming, WiFiManager portal, `provision` script |
| new | | `packages/wallet`, `render.yaml`, Supabase migrations |
| `/stage1` (teammate) | QR decode + intent prompt + USDC transfer code | **remove the deterministic 0G fallback and fake request ID** (disqualifying); use `@cpay/zerog` (request ID + receipt → `zg_evidence`); don't send the recipient to 0G; move signing to the phone (`packages/wallet`), delete `/api/stage1/pay` |
| `apps/issuer` (new `index.ts`, Prisma) | Hono server, Prisma client, `/health` | `/enrol` must verify the World proof before storing; BBS blind issuance; `commitment_hash` column |
| `packages/database` (Prisma) | client | add `glasses_units`, `zg_evidence` models; keep only the 3 invariant-3 tables (+ the issuer's public key) |
| chain | | code still defaults to **Ethereum Sepolia** (`SEPOLIA_USDC`, viem `sepolia` in `packages/stealth`, `apps/web`); switch to **Base Sepolia** (`baseSepolia`, USDC from env, chain 84532) |

## Order of work

**Abinav** (glasses: one ESP32-CAM + OLED, no buttons; `docs/DECISIONS.md` §13)
1. ~~Flash the diagnostics, confirm pins~~ (done: AI-Thinker map, GC2145, OLED SSD1306 0x3C).
2. Hub on Render: `/device` + `/phone` sockets, unit auth, pairing codes, owner tokens, routing, tickets, Supabase table. Publish `messages.ts` + `ticket.ts` first so the teammate can build against them.
3. Firmware (`cam` env only): wss to the hub, captive-portal Wi-Fi, provisioning, OLED on IO14/15 (pairing code + states), software-JPEG streaming on `stream{on}`.
4. 0G: evidence sink → `zg_evidence`, browser `encryptEpisode`, `uploadEpisode`, smoke run with the real key, request IDs + receipts into `EVIDENCE.md`. Ask the 0G booth the receipt questions.
5. Glasses README/wiring for the "plug and play" 0G judging point; book the 0G booth demo.

**Teammate**
1. Supabase project + migrations; `render.yaml`; deploy all 4 services early (even half-built), keep-alive cron.
2. `packages/wallet`: passkey PRF + derivation, agent wallet, policy + ledger, QR parser, direct pay.
3. PWA: onboarding → Wallet → Receive (public QR first, then CPay QR) → Pay (hub client, live feed, scan log, plain-QR direct pay) → Activity/Evidence → Settings (pairing).
4. World: issuer on Supabase, IDKit on the phone, CPay QR path (relay + proof), Agent Pass `link` + `approve`.
5. Models: pick `ZG_*` models (private-mode availability in `docs/STACK.md`).

## Known issues / later
- **STT and "two" (6 Nov):** private `whisper-large-v3` often writes "pay two USDC" as "pay to USDC". The intent prompt now reads homophones before the token ("to/too" -> 2, "for" -> 4), but "two" is still unreliable; "one"/"five" work well. Later: ask 0G about a Whisper `prompt` (vocabulary bias) or say amounts like "two dollars".
- **0G private latency:** STT ~5-28 s, intent ~3-13 s per call (timeout raised to 45 s).
- **Voice replies:** the 0G key is private-only and TTS has no private provider, so spoken replies fail; decide: phone's built-in voice vs a second standard-mode key.
- **Privacy review before the first merge to main (6 Nov), still open:**
  - Should fix: the Prisma schema differs from invariant 3 (`IssuerKey` table, `createdAt` columns, no `commitment_hash`); the issuer logs raw Prisma errors; the legacy bridge logs OLED text and IPs; the Agent Pass binding lacks `to`/subHash; the hub has no hard stream cap (add ~33 s on top of the refreshed 15 s); the confirm code goes to TTS and comes back in `/api/speak` text.
  - Notes: the JSONL fallback in `lib/server/runs.ts` keeps raw evidence; Render needs `NODE_ENV=production` so hub tickets are enforced; `apps/web/lib/audio.ts` is unused.
  - Known: the stage1 pay route still holds a server key (and logs a raw error); issuer `/enrol` doesn't verify with World yet.
  - Fixed: the dead `/api/pay` server signer and its ledger file are deleted.
- **Privacy review of `face-pay` (6 Nov), still open:**
  - BLOCKER before deploy: `apps/web/app/api/stage1/pay` signs with a server key (and `/stage1` links to it). Delete or keep out of the deployed build.
  - Should fix: the Agent Pass server holds `{to, amount, token}` next to the World `subHash` in memory for up to 5 min (send a salted commitment instead); a shown CPay QR answers any quote with no rate limit (add a per-display secret in the QR or a rate limit); the relay forwards face probes to any recipient (require a BBS proof at hello).
  - Notes: prefetch or pin the issuer public key so the issuer can't correlate payer and recipient by IP; enrolment camera stays on after a failed capture; one-time address records unencrypted in IndexedDB; `GlassesUnit.createdAt` (hub).
  - Fixed: face quotes now echo a sealed `matchSecret` (not the round-1 nonce every probed phone saw); probe embeddings are zeroed after compare; face disclosure says "every recipient online".
- **First face payment (6 Nov):** glasses face lock -> sealed probe -> recipient phone matched -> spoken amount -> quote -> verified BBS claim -> USDC + gas drop to a one-time address, over local services + Cloudflare quick tunnels.
- **World simulator gives the same nullifier (6 Nov):** a second tester (even in an incognito simulator window) got "already enrolled": the staging simulator returned the same identity/nullifier. We deleted the staging row to let the second phone enrol. Before the demo: find how to get distinct simulator identities, or enrol testers one at a time.
- **Pairing is per site:** the owner token lives in the browser per origin, so a new domain (tunnel, Render) needs a re-pair; the old pairing must be cleared first (unpair from the old origin, or clear `owner_token_hash`). Consider an "unpair" path the OLED can trigger.
- **Agent Pass not configured yet:** `AGENT_PASS_CLIENT_ID` / `AGENT_PASS_CLIENT_SECRET` are empty, so over-cap payments can't be approved.
- **First end-to-end payment (6 Nov, 00:20 IST):** glasses scan -> 0G STT + intent (private) -> spoken confirm code -> phone signs -> 1 USDC on Base Sepolia from agent wallet `0xfEfD0d9D...beE3fA146` to `0xa57F89A4...c65217094`.

## Checkpoints (IST, Fri 6 Nov)

| When | Must be true |
|---|---|
| 11:00 | All 4 services deployed on Render with `/health` + keep-alive. Passkey wallet created on a phone; agent wallet funded. Glasses pins confirmed; hub contract published. |
| 14:00 | **Plain-QR pay end to end** through the glasses: pair → tap Scan → live feed → QR decoded → spoken amount → 0G intent with request ID + receipt → spoken confirm code → phone signs → Base Sepolia tx. |
| 17:00 | World: IDKit → card on the phone; **CPay QR** private pay; non-verified rejection. Agent Pass approve + deny. Episode on 0G Storage. `/evidence` page. |
| 18:00 | **Feature freeze.** Bug fixes only. README: CROPS, "What breaks without 0G", World debriefs. |
| 21:00 | Video recorded (2:30–2:55, real voices, 720p+). |
| 23:59 | **Submitted** (World, 0G, EF). 0G booth hardware demo booked. |

Cut order if late: face path → Activity polish → invisible mode → public `/evidence` styling. **Never cut privacy invariants, World or 0G.**

## Merge loop
1. Each person works on their branch; commit small and often (one 6–9 word sentence per commit).
2. To merge into `main`: `pnpm test && pnpm typecheck && pnpm --filter @cpay/web build`, run the **privacy-reviewer** agent on the diff, fix findings, then merge (PR or fast-forward).
3. After a merge, the other person merges `main` into their branch.
4. Add a row to `AI_USAGE.md` for meaningful AI-assisted work.
