# Execution plan: one developer running parallel Claude Code agents

We're **2 humans**, but the plan assumes **one developer orchestrating agents**. Either of us can pick up any session.

**Our deadline: Fri 6 Nov, 23:59 IST, fully submitted.** The official deadline (Sat 7 Nov, 09:00 IST) is buffer only.

**Priorities, in order:**
1. **World** (IDKit + Agent Pass) and **0G** (Private Computer + Physical AI). These are the critical path.
2. Lite payment end to end (stealth address on Sepolia), since the demo needs money to move.
3. **EF CROPS**: README section, no trackers, keys on the device. Mostly docs and discipline, not code.
4. Out of scope unless all of the above is done: Anon-RPC, Railgun Full mode, the 0G iAI sign-in bonus.

## How many agents: 6 sessions at peak

| # | Session | Agent definition | Owns (only edits these) | Branch / worktree |
|---|---|---|---|---|
| 0 | **Integrator (lead)** | none (main checkout) | merges, `README.md`, `AI_USAGE.md`, `docs/`, root config | `main` |
| 1 | **Payments** | `.claude/agents/payments.md` | `packages/protocol`, `packages/stealth`, `apps/relay` | `wt-payments` |
| 2 | **Identity** (World) | `.claude/agents/identity.md` | `apps/issuer`, `packages/credential`, `packages/world` | `wt-identity` |
| 3 | **0G agent** | `.claude/agents/zerog.md` | `packages/zerog` | `wt-zerog` |
| 4 | **Frontend** | `.claude/agents/frontend.md` | `apps/web` (incl. `app/api/*` route handlers) | `wt-frontend` |
| 5 | **Hardware** | `.claude/agents/hardware.md` | `packages/glasses-kit` | `wt-hardware` |
| on demand | Privacy review | `.claude/agents/privacy-reviewer.md` | read-only | run from the integrator |

Why 5 builders and not more: these are the 5 areas with **disjoint files**, so there are no merge fights. More agents would collide in `apps/web`.

If you're short on attention or tokens, merge 3 into 4 (0G + frontend) and run 4 builders. **Don't drop identity or 0G.**

## Phases

**Phase 0: bootstrap (Thu, one session, about 60–90 min, nothing else runs)**
- Payments agent on `main`:
  - pnpm monorepo, `tsconfig.base.json`, vitest
  - `packages/protocol` + `packages/stealth` + `apps/relay` with tests, per `docs/ARCHITECTURE.md` "Implementation notes"
  - a Next.js shell in `apps/web` that builds
  - empty, typed package stubs for `@cpay/credential`, `@cpay/world`, `@cpay/zerog`, so the others can start against real imports
- Push. Everyone else depends on the `@cpay/protocol` interfaces, so this has to land first.

**Phase 1: fan out (5 worktrees in parallel)**

From the repo root, one terminal each:
```bash
claude --worktree identity    # "Use the identity agent. Start with packages/credential (confirm the BBS blind-sign API), then apps/issuer, then packages/world (IDKit + Agent Pass)."
claude --worktree zerog       # "Use the zerog agent. Build transcribe/parseIntent/logEpisode with request IDs and safe-stop."
claude --worktree payments    # "Use the payments agent. Continue its order of work: the real Sepolia pay script, then the QR claim path."
claude --worktree frontend    # "Use the frontend agent. Build /receive and /pay against @cpay/protocol + @cpay/stealth, plus the app/api routes; leave clearly typed hooks for credential/world/zerog."
claude --worktree hardware    # "Use the hardware agent. Ask me for the board and pins first."
```
- `.env` is copied into every worktree via `.worktreeinclude`. `.claude/worktrees/` is git-ignored.
- Each worktree runs `pnpm install` first.

**Integration loop (integrator, every ~2 hours)**
1. Merge each green worktree branch into `main`, in this order: payments → identity → zerog → frontend → hardware.
2. Run `pnpm test && pnpm typecheck` on `main`.
3. Run the **privacy-reviewer** agent on the merged diff; fix findings through the owning session.
4. Each worktree rebases on `main`.
5. Add rows to `AI_USAGE.md`.

**Phase 2: end-to-end (Fri morning to afternoon).** The frontend session wires everything together; the others fix bugs in their own areas only.

**Phase 3: freeze + submit (Fri evening).** The integrator writes the README (CROPS, World debriefs, tx links, 0G request IDs + root hashes). We record the video and submit.

## Checkpoints (IST)

| When | Must be true |
|---|---|
| **Thu 5 Nov 23:59** | Phase 0 merged. Relay deployed (`wss://`). Lite payment works on Sepolia with a **QR code** in place of the face (recipient shows a claim QR → payer verifies → pays). Issuer key generated; `/rp-signature` works against World staging. 0G router key works: one private-mode `whisper-large-v3` + `glm-5.3` call with `X-Request-ID` captured. |
| **Fri 6 Nov 11:00** | **World:** IDKit (staging/simulator) → issuer verify → nullifier stored → BBS card on the phone; a repeat enrolment is rejected. **0G:** `/api/intent` returns `{amount, token}` + request IDs; safe-stop when 0G is unreachable. Payer refuses claims it can't verify. Glasses POST captures to the bridge. |
| **Fri 6 Nov 15:00** | Face path end to end through the glasses. **Agent Pass** approve (pays) and deny (nothing happens). 0G Storage episode log with root hash. Privacy X-ray screen. |
| **Fri 6 Nov 18:00** | **Feature freeze.** Only bug fixes after this. README drafted: CROPS, "What breaks without 0G", World debriefs. |
| **Fri 6 Nov 21:00** | Video recorded (2:30–2:55, real voices, 720p+). Live demo link up. |
| **Fri 6 Nov 23:59** | **Submitted**, with partner prizes World, 0G, EF selected. Hardware demo booked at the 0G booth. |
| Sat 7 Nov 09:00 | Official deadline (buffer only; also continue committing for the "keeps building" signal). |

If a checkpoint slips by more than 2 hours, cut in this order: Privacy X-ray polish → glasses OLED polish → face path (fall back to QR plus the glasses for voice and confirm). **Never cut World or 0G.**

## Rules for every session
- Only edit the folders you own. Need something from another area? Write the request in the integrator session; don't edit it yourself.
- `packages/protocol` changes come only from the payments session, in their own commit, and the integrator announces them.
- No mocks in the demo path (see `CLAUDE.md`). Leave a typed interface plus a visible "not connected" state instead.
- Commit every meaningful step. Small commits, clear messages.

## Alternative: agent teams (experimental)
Claude Code can run one lead that spawns teammates sharing a task list. Enable it with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, then ask the lead to "spawn teammates using the payments, identity, zerog, frontend and hardware agent types". It uses far more tokens, and teammates aren't restored after `/resume`. Separate worktree sessions (above) are the default plan.

## Splitting between the two humans (optional)
- Human A: integrator + payments + identity + frontend.
- Human B: hardware + 0G, since that person is at the bench and at the 0G booth.

Each human runs their sessions in their own clone; the integrator merges.
