# Execution plan: one developer running parallel Claude Code agents

We're **2 humans**, but the plan assumes **one developer orchestrating agents**. Either of us can pick up any session. Deadline: **Sat 7 Nov, 09:00 IST** (submit by 08:00).

## How many agents: 6 sessions at peak

| # | Session | Agent definition | Owns (only edits these) | Branch / worktree |
|---|---|---|---|---|
| 0 | **Integrator (lead)** | none (main checkout) | merges, `README.md`, `AI_USAGE.md`, root config | `main` |
| 1 | **Payments** | `.claude/agents/payments.md` | `packages/protocol`, `packages/stealth`, `packages/railgun`, `apps/relay` | `wt-payments` |
| 2 | **Identity** | `.claude/agents/identity.md` | `apps/issuer`, `packages/credential`, `packages/world` | `wt-identity` |
| 3 | **0G agent** | `.claude/agents/zerog.md` | `packages/zerog` | `wt-zerog` |
| 4 | **Frontend** | `.claude/agents/frontend.md` | `apps/web` | `wt-frontend` |
| 5 | **Hardware** | `.claude/agents/hardware.md` | `packages/glasses-kit` | `wt-hardware` |
| on demand | Privacy review | `.claude/agents/privacy-reviewer.md` | read-only | run from the integrator |

Why 5 builders and not more: these are the 5 areas with **disjoint files**, so there are no merge fights. More agents would collide in `apps/web`. Fewer would leave the critical path (identity, then frontend) idle.

If you're short on attention or tokens, merge 3 into 4 (0G + frontend) and run 4 builders.

## Phases

**Phase 0: bootstrap (one session, about 60–90 min, nothing else runs)**
- Payments agent on `main`:
  - pnpm monorepo, `tsconfig.base.json`, vitest, MIT `LICENSE`
  - `packages/protocol` + `packages/stealth` + `apps/relay` with tests, per `docs/ARCHITECTURE.md` "Implementation notes"
  - a Next.js shell in `apps/web` that builds
- Push. Everyone else depends on `@cpay/protocol` interfaces, so this has to land first.

**Phase 1: fan out (5 worktrees in parallel)**

From the repo root, one terminal each:
```bash
claude --worktree payments    # then: "Use the payments agent. Continue its order of work from step 1."
claude --worktree identity    # "Use the identity agent. Build packages/credential (plain BBS first), then apps/issuer, then packages/world."
claude --worktree zerog       # "Use the zerog agent. Build transcribe/parseIntent/logEpisode with safe-stop."
claude --worktree frontend    # "Use the frontend agent. Build /receive and /pay against @cpay/protocol + @cpay/stealth; leave clearly typed hooks for credential/world/zerog."
claude --worktree hardware    # "Use the hardware agent. Ask me for the board and pins first."
```
- Copy `.env` into every worktree automatically by putting `.env` in `.worktreeinclude`. Add `.claude/worktrees/` to `.gitignore`.
- Each worktree runs `pnpm install` first.

**Integration loop (integrator, every ~2 hours)**
1. Merge each worktree branch that's green into `main`, in this order: payments → identity → zerog → frontend → hardware.
2. Run `pnpm test && pnpm typecheck` on `main`.
3. Ask the integrator Claude to run the **privacy-reviewer** agent on the merged diff, and fix findings via the owning session.
4. Each worktree rebases on `main`.
5. Add rows to `AI_USAGE.md`.

**Phase 2: end-to-end (Fri afternoon)**: the frontend session wires everything; the others fix bugs in their own areas only.

**Phase 3: freeze (Fri 23:00)**: the integrator writes the README (CROPS, debriefs, tx links, request IDs) and we record the video. Railgun Full mode lands only if Phase 2 is solid.

## Checkpoints
| When | Must be true |
|---|---|
| Thu 23:59 | Phase 0 merged. Lite payment works on Sepolia using a **QR code** in place of the face (recipient shows a claim QR → payer verifies → pays). Relay deployed. |
| Fri 14:00 | World IDKit (staging) → issuer → BBS cards; the payer refuses claims it can't verify. 0G intent returns request IDs. Glasses POST captures to the bridge. |
| Fri 18:00 | Face path end to end on the glasses. Agent Pass approve/deny. Privacy X-ray screen. 0G Storage logs + safe-stop. |
| Fri 23:00 | Freeze. Optional Railgun. Video recorded (2:30–2:55). |
| Sat 08:00 | Submitted with partner prizes World, 0G, EF. |

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
