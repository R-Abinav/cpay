# Team plan

Two humans, each running Claude Code (with parallel agents if useful). **Our deadline: Fri 6 Nov, 23:59 IST, fully submitted.**

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

## Order of work

**Abinav**
1. Flash the diagnostics (`c3-i2c-scan`, `cam-probe`), confirm pins.
2. Hub on Render: `/device` + `/phone` sockets, unit auth, pairing codes, owner tokens, routing, tickets, Supabase table. Publish `messages.ts` + `ticket.ts` first so the teammate can build against them.
3. Firmware: wss to the hub, captive-portal Wi-Fi, provisioning, pairing code on the OLED, burst streaming (QVGA ~5 fps while CAPTURE held + 3 s).
4. 0G: evidence sink → `zg_evidence`, browser `encryptEpisode`, `uploadEpisode`, smoke run with the real key, request IDs + receipts into `EVIDENCE.md`. Ask the 0G booth the receipt questions.
5. Glasses README/wiring for the "plug and play" 0G judging point; book the 0G booth demo.

**Teammate**
1. Supabase project + migrations; `render.yaml`; deploy all 4 services early (even half-built), keep-alive cron.
2. `packages/wallet`: passkey PRF + derivation, agent wallet, policy + ledger, QR parser, direct pay.
3. PWA: onboarding → Wallet → Receive (public QR first, then CPay QR) → Pay (hub client, live feed, scan log, plain-QR direct pay) → Activity/Evidence → Settings (pairing).
4. World: issuer on Supabase, IDKit on the phone, CPay QR path (relay + proof), Agent Pass `link` + `approve`.
5. Models: pick `ZG_*` models (private-mode availability in `docs/STACK.md`).

## Checkpoints (IST, Fri 6 Nov)

| When | Must be true |
|---|---|
| 11:00 | All 4 services deployed on Render with `/health` + keep-alive. Passkey wallet created on a phone; agent wallet funded. Glasses pins confirmed; hub contract published. |
| 14:00 | **Plain-QR pay end to end** through the glasses: pair → hold CAPTURE → live feed → QR decoded → 0G intent with request ID + receipt → CONFIRM → phone signs → Sepolia tx. |
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
