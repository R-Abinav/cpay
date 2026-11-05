# CPay ("See-Pay")

Smart glasses for private payments: look at someone, say "pay her 2 USDC", press confirm.
Built at **ETHGlobal Mumbai (5–7 Nov 2026)** by 2 humans orchestrating parallel Claude Code agents (plan: `docs/TEAM.md`). **Submission deadline: Sat 7 Nov, 9:00 AM IST.** Late submissions aren't accepted.

The one-line pitch: **your face picks you out but never identifies you.**

## Privacy invariants (never break these)

1. **No face→wallet mapping exists anywhere.** Not in a DB, not on-chain, not in logs.
2. **Faces stay on the owner's phone.** The recipient's face template never leaves their device. The payer's capture is turned into an embedding locally, the photo is deleted, and the embedding is only ever sent *sealed* to nearby phones.
3. **The backend stores only used World ID nullifiers + the issuer key.** No faces, no wallets, no payment history, no IPs in logs.
4. **The relay sees ciphertext only** and persists nothing.
5. **The payer learns only:** "a World-verified human" (BBS proof) + a one-time destination.
6. **Every recipient proof is bound** to `bindingDigest({sessionNonce, destination, chainId, token, amount})`. The payer verifies the proof before paying, always.
7. **The AI proposes, never holds keys.** 0G parses intent; a deterministic policy engine and the user's own keys decide and sign.
8. **No mocked decisions, payments or proofs in the demo path.** If 0G, World or the chain is unreachable, stop visibly (safe-stop). Faking a decision is disqualifying for 0G. Test fixtures are fine *inside tests only*.
9. **No third-party trackers or analytics in any client** (EF CROPS rule).

If a task seems to need breaking one of these, stop and ask the human.

## Read these (in this order when starting a new area)

| Doc | What's in it |
|---|---|
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
(0) onboarding, once:     recipient proves Proof of Human with World IDKit -> issuer blind-signs a BBS card
(1) glasses button:       centred face crop + voice -> payer bridge
(2) intent:               voice -> 0G Private Computer (private mode) -> {amount, token} + request ID
(3) policy:               cap check; over cap -> World Agent Pass step-up (denied => no payment)
(4) probe:                relay fans out {nonce, sealed embedding, amount...} to nearby recipient phones
(5) claim:                only the matching phone answers: BBS proof (bound) + fresh destination
                          zero or >1 valid claims -> abort -> QR fallback
(6) confirm:              OLED "verified human · 2 USDC" -> physical confirm button
(7) settle on Sepolia:    lite = USDC + gas drop -> recipient-generated stealth address
                          full = Railgun 0zk -> 0zk via Kohaku (hides payer, recipient, amount)
(8) log:                  encrypted episode log + request ID -> 0G Storage
```

## Partner prizes (max 3 selected; full requirements: `docs/SPONSORS.md`)

- **World**: Best Use of IDKit + Agent Pass (one slot covers both)
- **0G**: Physical AI "Agents with a Body" (glasses lane) + Build with 0G Private Computer
- **EF**: Best CROPS App (Anon-RPC is a bonus; a project can win only one EF prize)

## Repo layout (pnpm monorepo, TypeScript ESM, one web app) — to build

| Path | Owner agent | What |
|---|---|---|
| `packages/protocol` | payments (shared by all) | sealed boxes, relay wire schema (zod), `bindingDigest`, local face matching, probe/claim session helpers |
| `packages/stealth` | payments | ERC-5564 recipient-generated one-time addresses, pay, sweep |
| `apps/relay` | payments | stateless WebSocket relay |
| `packages/railgun` | payments | full-privacy mode via `@kohaku-eth/railgun` |
| `apps/web` | frontend | Next.js: `/receive` (recipient) + `/pay` (payer console) |
| `apps/issuer` | identity | World verify + nullifier store + BBS issuance |
| `packages/credential` | identity | BBS issue / prove / verify |
| `packages/world` | identity | IDKit 4 + Agent Pass helpers |
| `packages/zerog` | zerog | 0G router intent + 0G Storage episode log |
| `packages/glasses-kit` | hardware | ESP32-S3 firmware + bridge, a plug-and-play package |

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
pnpm web             # http://localhost:3000 (0G iAI sign-in only works on :3000/:3001/:5173)
pnpm --filter @cpay/stealth pay   # real Sepolia payment through a stealth address (script to build; needs .env)
```

## Working rules

- **Stay in your area.** Edit only files your area owns (table above). Need a change elsewhere? Ask that area's agent or the human.
- **Verify before integrating.** Sponsor SDKs change fast. Read the linked docs (`docs/SPONSORS.md`) before writing integration code. Never invent an endpoint, header or model ID; when docs are silent, say so and ask.
- **Testnets only** (Ethereum Sepolia, 0G Galileo). Never put a key in code; use `.env` (see `.env.example`).
- **Commit small and often**, with clear messages. Finalist repos average ~60 commits; ETHGlobal reads git history.
- **Log AI-assisted work** in `AI_USAGE.md` (ETHGlobal rule): one row per meaningful change. Keep specs/prompts in `docs/`.
- **TypeScript ESM**, relative imports use `.js` suffixes (Next maps them via `extensionAlias`). Validate all wire input with zod.
- **Don't implement cryptographic primitives.** Use audited libs (`@noble/*`, ScopeLift stealth SDK, a BBS WASM lib, Kohaku). Composition code is fine.
- **Demo-first.** Every feature must show up in the demo video (target 2:30–2:55: ETHGlobal wants 2–4 min, 0G wants under 3; real voices, no AI voiceover) or in the README.
