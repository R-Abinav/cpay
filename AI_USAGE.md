# AI usage (required by ETHGlobal rules)

We used AI coding assistants during the hackathon. This file lists what they produced so judges can see where the team directed the work.

| Date (IST) | Tool | What it produced | Files |
|---|---|---|---|
| 2026-11-05 | Claude (chat) | Architecture, privacy design, sponsor research, these docs and agent definitions | `CLAUDE.md`, `docs/*`, `.claude/agents/*` |
| 2026-11-05 | Claude Code | Re-verified sponsor docs (0G request-ID header, private-mode models, Anon-RPC Sepolia, IDKit nullifier storage); tech stack doc; timeline moved to Fri 23:59; scope cuts; agent definitions; env template | `docs/STACK.md`, `docs/*.md`, `CLAUDE.md`, `.claude/agents/*`, `.env.example`, `.gitignore`, `.worktreeinclude` |
| 2026-11-05 | Claude Code | Agent-wallet + voice-loop design from the team's direction (earbud push-to-talk, 0G STT/LLM/TTS, template replies, signing gate, Agent Pass bound to amount); verified the 0G `/v1/audio/speech` endpoint | `CLAUDE.md`, `docs/*.md`, `.claude/agents/*`, `.env.example` |

Specs, prompts and planning notes live in `docs/`. Add a row for every AI-assisted change.
