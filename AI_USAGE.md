# AI usage (required by ETHGlobal rules)

We used AI coding assistants during the hackathon. This file lists what they produced so judges can see where the team directed the work.

| Date (IST) | Tool | What it produced | Files |
|---|---|---|---|
| 2026-11-05 | Claude (chat) | Architecture, privacy design, sponsor research, these docs and agent definitions | `CLAUDE.md`, `docs/*`, `.claude/agents/*` |
| 2026-11-05 | Claude Code | Re-verified sponsor docs (0G request-ID header, private-mode models, Anon-RPC Sepolia, IDKit nullifier storage); tech stack doc; timeline moved to Fri 23:59; scope cuts; agent definitions; env template | `docs/STACK.md`, `docs/*.md`, `CLAUDE.md`, `.claude/agents/*`, `.env.example`, `.gitignore`, `.worktreeinclude` |
| 2026-11-05 | Claude Code | Agent-wallet + voice-loop design from the team's direction (earbud push-to-talk, 0G STT/LLM/TTS, template replies, signing gate, Agent Pass bound to amount); verified the 0G `/v1/audio/speech` endpoint | `CLAUDE.md`, `docs/*.md`, `.claude/agents/*`, `.env.example` |
| 2026-11-05 | Claude Code | Doc review: issuer stores exactly 3 things; invariant 8 clarifies World staging is allowed; BBS library rationale; 0G evidence rule (request ID + receipt per call, logged + stored) | `CLAUDE.md`, `docs/*.md`, `.claude/agents/*`, `.env.example` |
| 2026-11-05 | Claude Code (payments agent) | Phase 0 bootstrap: pnpm workspace + strict NodeNext tsconfig + vitest; `@cpay/protocol` (X25519/HKDF/AES-GCM sealing via @noble, zod relay schema, `bindingDigest`, face matching, probe/claim helpers); `@cpay/stealth` (ScopeLift SDK one-time addresses, pay + gas drop, sweep, anvil test, Sepolia pay script); `apps/relay` (ws relay + 3-recipient e2e test); Next.js shell; typed stubs for credential/world/zerog | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `packages/{protocol,stealth,credential,world,zerog}`, `apps/{relay,web}` |
| 2026-11-05 | Claude Code (hardware agent) | Glasses kit: ESP32-CAM + ESP32-C3 firmware (display/buttons, camera, I²C scan, camera-map probe), Node bridge with zod schemas + tests, WIRING/README. Pins unconfirmed until flashed by the team | `packages/glasses-kit/*` |
| 2026-11-06 | Claude Code | Product architecture docs: passkey wallet on phone, Render hub, Supabase, QR-first, team split | `CLAUDE.md`, `docs/*`, `.claude/agents/*`, `.env.example` |

Specs, prompts and planning notes live in `docs/`. Add a row for every AI-assisted change.
