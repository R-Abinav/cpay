# CPay ("See-Pay")

Smart glasses + earbuds for private payments:
- Look at someone and say **"Hey Pay, pay her 2 USDC"** into your earbuds.
- The agent answers by voice: "Sure, I'll initiate a 2 USDC payment."
- You press confirm on the glasses.

An **agent wallet** with a spend cap makes every transfer. **World Agent Pass** approves anything over the cap, and **World ID** (a nullifier-gated credential) proves the recipient is a unique human. **0G** is the agent's ears, brain and voice: speech-to-text, intent and text-to-speech on 0G-hosted models, paid with 0G credits.
Built at **ETHGlobal Mumbai (5–7 Nov 2026)** by 2 humans orchestrating parallel Claude Code agents (plan: `docs/TEAM.md`).
**Our deadline: Fri 6 Nov, 23:59 IST (fully submitted).** The official ETHGlobal deadline is Sat 7 Nov, 09:00 IST, and late submissions aren't accepted; Saturday morning is buffer only.

**Priority order:** World (IDKit + Agent Pass) and 0G (Private Computer + Physical AI) first, then EF **CROPS** (README section + no trackers). Anon-RPC and Railgun Full mode are roadmap, not in scope unless everything else is done.

The one-line pitch: **your face picks you out but never identifies you.**

## Privacy invariants (never break these)

1. **No face→wallet mapping exists anywhere.** Not in a DB, not on-chain, not in logs.
2. **Faces stay on the owner's phone.** The recipient's face template never leaves their device. The payer's capture is turned into an embedding locally, the photo is deleted, and the embedding is only ever sent *sealed* to nearby phones.
3. **The issuer (our only backend) stores exactly three things:** used World ID nullifiers, the World RP signing key (to sign IDKit requests), and the BBS issuer secret key (to sign cards). No faces, no wallets, no payment history, no IPs in logs. It plays no part in payments.
4. **The relay sees ciphertext only** and persists nothing.
5. **The payer learns only:** "a World-verified human" (BBS proof) + a one-time destination.
6. **Every recipient proof is bound** to `bindingDigest({sessionNonce, destination, chainId, token, amount})`. The payer verifies the proof before paying, always.
7. **The LLM proposes; it never holds keys or decides.**
   - 0G parses intent and speaks.
   - The **agent wallet key** is held only by deterministic agent-runtime code on the payer's machine (`apps/web/app/api/pay`). It never reaches the browser, an LLM prompt, logs or 0G.
   - That code signs only after: policy pass → (Agent Pass approval if over cap) → verified recipient proof → physical confirm.
   - Spoken replies are fixed templates driven by the real state, never LLM free text.
8. **We never mock anything in the demo path.** No fake 0G decisions, no fake payments, no fake proofs written by us. If 0G, World or the chain is unreachable, stop visibly (safe-stop). Faking a decision is disqualifying for 0G. Test fixtures are fine *inside tests only*.
   - **Allowed:** World's own staging environment (simulator identities, `environment: "staging"`) and World's mocked Agent Pass identities. Those are World's official dev path, the real verify API still runs, and moving to production is a config switch (`WORLD_ENVIRONMENT=production` + real Orb-verified World IDs). Keep that switch to env vars only, never code branches.
9. **No third-party trackers or analytics in any client** (EF CROPS rule).

If a task seems to need breaking one of these, stop and ask the human.

## Read these (in this order when starting a new area)

| Doc | What's in it |
|---|---|
| `docs/STACK.md` | **Tech stack**: frontend, payer-side server, issuer, relay, (no) contracts, hosting, verified 0G details |
| `docs/TEAM.md` | **Execution plan.** 6 sessions (integrator + 5 builders in worktrees), phases, checkpoints, merge loop |
| `docs/ARCHITECTURE.md` | Components, protocol, modes, who learns what, threats, **implementation notes** |
| `docs/DECISIONS.md` | Why the design is this way; rejected alternatives. Read before proposing changes |
| `docs/SPONSORS.md` | Exact prize requirements + doc links + endpoints; items to verify |
| `docs/HACKATHON.md` | ETHGlobal rules, judging, demo moments, video script, pitch, judge Q&A, submission checklist |
| `docs/HARDWARE.md` | BOM, firmware/bridge split, OLED states |
| `docs/GLOSSARY.md` | Terms: nullifier, BBS, stealth address, CROPS, Railgun… |
| `.claude/agents/*.md` | One definition per area + `privacy-reviewer` |

## Flow (details: `docs/ARCHITECTURE.md`)

```
(0)  recipient, once:   World IDKit Proof of Human -> issuer verifies + stores nullifier -> blind-signs a BBS card
(0') payer, once:       fund the AGENT WALLET with a small USDC + ETH budget; caps are set in config
(1)  push-to-talk:      glasses CAPTURE button -> face crop (glasses camera) + "Hey Pay, pay her 2 USDC" (earbud mic)
(2)  ears + brain (0G): audio -> 0G whisper-large-v3 (private) -> text -> 0G glm-5.3 (private) -> {amount, token} + request IDs
(3)  voice (0G):        template reply -> 0G TTS -> earbuds: "Sure, I'll initiate a 2 USDC payment"
(4)  policy:            deterministic caps; over cap -> World Agent Pass step-up (denied => nothing paid, voice says so)
(5)  probe:             relay fans out {nonce, sealed embedding, amount...} to nearby recipient phones
(6)  claim:             only the matching phone answers: BBS proof (bound) + fresh destination
                        zero or >1 valid claims -> abort -> QR fallback
(7)  confirm:           OLED + voice "verified human, 2 USDC, confirm?" -> physical CONFIRM button
(8)  settle (Sepolia):  AGENT WALLET signs: USDC + gas drop -> recipient-generated stealth address
                        (full = Railgun via Kohaku: ROADMAP)
(9)  log + speak:       encrypted episode (request IDs, tx hash) -> 0G Storage root hash; voice: "Paid."
```

## Partner prizes (max 3 selected; full requirements: `docs/SPONSORS.md`)

- **World**: Best Use of IDKit + Agent Pass (one slot covers both)
- **0G**: Physical AI "Agents with a Body" (glasses lane) + Build with 0G Private Computer. Voice in, intent and voice out all run on 0G-hosted models with our 0G credits.
- **EF**: Best CROPS App (a project can win only one EF prize; Anon-RPC is deferred)

## Repo layout (pnpm monorepo, TypeScript ESM, one web app) — to build

| Path | Owner agent | What |
|---|---|---|
| `packages/protocol` | payments (shared by all) | sealed boxes, relay wire schema (zod), `bindingDigest`, local face matching, probe/claim session helpers |
| `packages/stealth` | payments | ERC-5564 recipient-generated one-time addresses, pay, sweep |
| `apps/relay` | payments | stateless WebSocket relay |
| `packages/railgun` | payments | ROADMAP: full-privacy mode via `@kohaku-eth/railgun` (don't scaffold until told) |
| `apps/web` | frontend | Next.js: `/receive` (recipient) + `/pay` (payer console) + payer-side agent runtime `app/api/*` (0G intent/speak/episode, Agent Pass, **`/api/pay` = the only code that holds the agent wallet key**) |
| `apps/issuer` | identity | Hono + SQLite: World verify + nullifier store + BBS issuance |
| `packages/credential` | identity | BBS issue / prove / verify |
| `packages/world` | identity | IDKit 4 helpers + Agent Pass OIDC helpers (used by `apps/web` route handlers) |
| `packages/zerog` | zerog | 0G router intent + 0G Storage episode log |
| `packages/glasses-kit` | hardware | ESP32-CAM + ESP32-C3 firmware + bridge, a plug-and-play package |

Package scope: `@cpay/*`. Shared interfaces live in `packages/protocol`. **Change them only in their own commit, and tell the other agents.**

## Bootstrapping (first session only)

If the repo is empty, the first session (payments agent) does three things before anyone splits off:
1. Scaffolds the pnpm workspace (`apps/*`, `packages/*`), a shared `tsconfig.base.json`, vitest and MIT `LICENSE`.
2. Builds `packages/protocol`, `packages/stealth` and `apps/relay` with tests, following "Implementation notes" in `docs/ARCHITECTURE.md`, plus a Next.js shell in `apps/web` that builds.
3. Pushes.

Other areas start right after, against those interfaces.

## Commands

```bash
pnpm install
pnpm test            # all packages; must stay green
pnpm typecheck
pnpm relay           # ws://localhost:8787
pnpm issuer          # http://localhost:8788
pnpm web             # http://localhost:3000 (0G iAI sign-in only works on :3000/:3001/:5173)
pnpm --filter @cpay/stealth pay   # real Sepolia payment through a stealth address (script to build; needs .env)
```

## Working rules

- **Stay in your area.** Edit only files your area owns (table above). Need a change elsewhere? Ask that area's agent or the human.
- **Verify before integrating.** Sponsor SDKs change fast. Read the linked docs (`docs/SPONSORS.md`) before writing integration code. Never invent an endpoint, header or model ID; when docs are silent, say so and ask.
- **Testnets only** (Ethereum Sepolia, 0G Galileo). Never put a key in code; use `.env` (see `.env.example`). Only `NEXT_PUBLIC_*` vars may reach the browser, and never a secret.
- **Commit small and often**, with clear messages. Finalist repos average ~60 commits; ETHGlobal reads git history.
- **Log AI-assisted work** in `AI_USAGE.md` (ETHGlobal rule): one row per meaningful change. Keep specs/prompts in `docs/`.
- **TypeScript ESM**, relative imports use `.js` suffixes (Next maps them via `extensionAlias`). Validate all wire input with zod.
- **Don't implement cryptographic primitives.** Use audited libs (`@noble/*`, ScopeLift stealth SDK, a BBS WASM lib, Kohaku). Composition code is fine.
- **0G evidence is mandatory.** Every 0G call records its request ID **and receipt**, prints them in the server log, and keeps them (JSONL + episode + UI). Never drop or swallow them. Details: "0G evidence" in `docs/STACK.md`.
- **Demo-first.** Every feature must show up in the demo video (target 2:30–2:55: ETHGlobal wants 2–4 min, 0G wants under 3; real voices, no AI voiceover) or in the README.
