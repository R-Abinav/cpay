# CPay

**A privacy-first wallet with hands-free glasses.** Everyone gets the same app (a PWA). Anyone can **receive**. When your own glasses are paired and online, you can also **pay**: look at a QR code, tap **Scan**, say "pay 2 USDC", then say the confirm code shown on the glasses ("confirm 47"). No buttons on the glasses.

- Your **keys live only on your phone**, derived from your passkey. Our servers never hold a user's key or money.
- An **agent wallet** (yours, on your phone) makes the transfer, within spend caps you set. Over a cap, **World Agent Pass** asks you to prove you're the human behind the wallet.
- **World ID** (Proof of Human) lets a recipient prove "I'm a verified unique human" without revealing who they are.
- **0G** is the agent's ears, brain and voice (speech-to-text, intent, spoken replies), in 0G private mode, with a request ID and receipt for every call.

Built at **ETHGlobal Mumbai (5–7 Nov 2026)** by 2 humans (Abinav: hardware + 0G; teammate: software) with Claude Code. Plan: `docs/TEAM.md`.
**Our deadline: Fri 6 Nov, 23:59 IST, fully submitted.** Official deadline Sat 7 Nov 09:00 IST (buffer only).
**Finalist rule: the backend must be deployed. We deploy on Render** (`docs/STACK.md`).

## Privacy comes first. Always.

This is rule zero, above features and above the deadline. Why:
- **Payments are the most revealing data there is.** They show who you know, where you go, what you earn and spend. A leak isn't embarrassing; it's dangerous.
- **A camera on someone's face is a trust problem.** People around a glasses wearer never agreed to anything. The product is only acceptable if it provably can't identify or track them.
- **Whatever a server stores, it will eventually leak** (breach, subpoena, insider, acquisition). The only safe data is data we never collect. So we design so that **there is nothing worth stealing** on our side.
- **It's the product and the pitch.** World and the EF (CROPS) judge exactly this. "Trust, money and safety around agents" is what wins.

When privacy and convenience conflict, privacy wins. If you're unsure whether something leaks, assume it does and ask the human.

## Privacy invariants (never break these)

1. **No user keys or money on any server.** Every user key (agent wallet, stealth, BBS holder secret, episode key) is derived **on the device** from the user's passkey. Signing happens **on the device**. Servers hold only *our* operational keys (0G credits, 0G Storage gas, World RP key, BBS issuer key, Agent Pass client + approval key), never a user's.
2. **No identity → wallet mapping exists anywhere.** No accounts, emails, phone numbers or names. No table, log or chain record links a person, face or World ID to a wallet.
3. **Servers store only what's listed here** (Supabase/Postgres, server-side only):
   - `nullifiers(nullifier, action, commitment_hash)`: one row per World-verified human (issuer)
   - `glasses_units(unit_id, unit_secret_hash, owner_token_hash)`: which glasses unit is paired to which (anonymous) phone token (hub)
   - `zg_evidence(...)`: 0G request IDs, receipts, model, status, root hashes (0G proof; no user data)
   - Nothing else. No wallet addresses, payment history, IPs, user agents or request bodies, in tables or logs.
4. **Pass-through services persist nothing and log no content.**
   - Relay: ciphertext only.
   - Glasses hub: frames and OLED text in memory only, forwarded to the paired phone and dropped. (Not end-to-end encrypted yet: **disclosed**.)
   - 0G proxy (`/api/intent`, `/api/speak`): audio and text pass to 0G and back, never stored or logged.
5. **The payer learns only what the recipient chose to show:** a one-time address + "World-verified human" (CPay QR), or the public address on a plain QR.
6. **Every recipient proof is bound** to `bindingDigest({sessionNonce, destination, chainId, token, amount})`. The payer verifies it before paying, always.
7. **The AI proposes; it never holds keys, decides, or picks a destination.** 0G returns `{amount, token}` only. The destination comes only from a scanned QR or a verified claim. Deterministic policy code on the phone decides; the phone signs after: policy → (Agent Pass if over cap) → (verified proof for CPay QR) → **spoken confirmation**: the wearer says "confirm" + a one-time 2-digit code shown only on their OLED; deterministic code on the phone checks the transcript (never an LLM); anything else, silence or "cancel" cancels; tap fallback on the phone after 2 failed tries. Spoken replies are fixed templates.
8. **Private by default.** The Receive tab shows the **private** CPay QR first. The camera streams only after the user taps **Scan**, stops the moment a QR is read, and at most 30 s (+3 s to re-aim after a miss). The mic records only for the spoken amount (until silence, max 8 s) and the 5 s confirm window. No wake word, no always-on mic or camera.
9. **We never mock anything in the demo path.** No fake 0G decisions, payments or proofs. If 0G, World or the chain is unreachable, stop visibly (safe-stop). Faking a decision is disqualifying for 0G. Test fixtures only inside tests.
   - Allowed: World's own staging/simulator and sandbox Agent Pass identities (World's official dev path; the real verify APIs still run). Production is an env switch, never a code branch.
10. **No third-party trackers, analytics, CDNs or fonts in any client** (EF CROPS). The browser never talks to Supabase. Models and WASM are self-hosted.

If a task seems to need breaking one of these, stop and ask the human.

## Read these (in this order when starting a new area)

| Doc | What's in it |
|---|---|
| `docs/ARCHITECTURE.md` | **The design**: components, onboarding, pairing, pay flow, QR formats, who learns what, threats, implementation notes |
| `docs/STACK.md` | Tech stack, Render services, Supabase schema, env per service, 0G specifics |
| `docs/TEAM.md` | Who owns what (Abinav vs teammate), contracts between areas, branches, checkpoints |
| `docs/DECISIONS.md` | Why the design is this way; rejected alternatives. §12 is the current product architecture |
| `docs/SPONSORS.md` | Exact prize requirements, doc links, endpoints |
| `docs/HACKATHON.md` | Rules, demo moments, video script, pitch, judge Q&A, submission checklist |
| `docs/HARDWARE.md` | Glasses hardware, power, provisioning, pairing, OLED states |
| `docs/GLOSSARY.md` | Terms |
| `.claude/agents/*.md` | One definition per area + `privacy-reviewer` |

## Flow (details: `docs/ARCHITECTURE.md`)

```
(0) onboarding, once per person (~60 s, in the PWA):
      create passkey -> PRF secret -> derive all keys on device (agent wallet, stealth, BBS holder, episode key)
      verify human with World IDKit (Proof of Human) -> issuer blind-signs a BBS card -> stored on device
      fund your agent wallet (shown as a QR/address in Wallet)
(1) pair glasses, once: OLED shows a 6-char code -> type it in Settings -> hub links unit <-> this phone
(2) pay: Pay tab unlocks only while YOUR glasses are online
      tap Scan -> glasses camera streams (hub -> your phone, live feed); phone decodes every frame on device
      QR read -> camera off at once; CPay QR (private, verified human) or plain address / EIP-681 (public)
      no QR in 30 s -> "NO QR - TAP TO RETRY" (one tap retries)
      beep -> phone records earbud mic until silence -> /api/intent -> 0G (private mode) -> {amount, token}
        + request ID + receipt -> voice "Sure, 2 USDC"
      CPay QR -> relay -> recipient phone answers: fresh one-time address + BBS proof bound to bindingDigest -> verify
      policy on phone (caps); over cap -> World Agent Pass -> signed single-use approval
      OLED "PAY 2 USDC / SAY CONFIRM 47" + voice -> mic 5 s -> 0G STT -> phone code checks "confirm 47"
      phone signs with the agent wallet -> Base Sepolia (CPay: USDC + gas drop to one-time address; plain: USDC to address)
      phone encrypts the episode -> /api/episode -> 0G Storage root hash -> voice "Paid"
(3) receive: show your private CPay QR (default) or your public address QR; anyone can receive, no glasses needed
```

## Partner prizes (max 3; requirements: `docs/SPONSORS.md`)
- **World**: Best Use of IDKit + Agent Pass
- **0G**: Physical AI "Agents with a Body" (glasses) + Build with 0G Private Computer
- **EF**: Best CROPS App

## Repo layout (pnpm monorepo, TypeScript ESM)

| Path | Owner | What | Deployed as |
|---|---|---|---|
| `apps/web` | teammate | Next.js PWA (Wallet / Pay / Receive / Activity / Settings / Evidence) + API routes: 0G proxy, Agent Pass, episode upload, evidence | Render `cpay-web` |
| `packages/wallet` | teammate | **On-device wallet**: passkey PRF → key derivation, agent wallet signing, policy engine + ledger, pay (direct / one-time), QR parsing | (library, browser) |
| `packages/protocol` | teammate | sealed boxes, relay wire schema (zod), `bindingDigest`, face matching, probe/claim helpers (face + CPay QR) | (library) |
| `packages/stealth` | teammate | ERC-5564 recipient-generated one-time addresses, pay, sweep | (library) |
| `apps/relay` | teammate | stateless WebSocket relay | Render `cpay-relay` |
| `apps/issuer` | teammate | World verify + nullifier store (Supabase) + BBS blind issuance | Render `cpay-issuer` |
| `packages/credential` | teammate | BBS issue / prove / verify | (library) |
| `packages/world` | teammate | IDKit helpers + Agent Pass OIDC + approval tokens | (library) |
| `packages/zerog` | **Abinav** | 0G router client (STT, intent, TTS), evidence, safe-stop, 0G Storage upload, browser-side episode encryption | (library) |
| `packages/glasses-kit` | **Abinav** | ESP32-CAM firmware (camera + OLED, one board), provisioning, and the **glasses hub** (pairing + frame/OLED routing) | Render `cpay-hub` |
| `render.yaml` | shared (each edits only their service block) | Render Blueprint | |

Package scope: `@cpay/*`. Shared interfaces (contracts between owners) are listed in `docs/TEAM.md`. **Change a contract only in its own commit and tell the other human.**

## Commands

```bash
pnpm install
pnpm test            # all packages; must stay green
pnpm typecheck
pnpm web             # http://localhost:3000
pnpm relay           # ws://localhost:8787
pnpm issuer          # http://localhost:8788
pnpm hub             # ws://localhost:8790 (glasses + phones)
pnpm --filter @cpay/zerog smoke   # one real 0G call of each kind; prints request IDs + receipts
```
Phones need HTTPS (camera, mic, passkeys): use the Render URL, or a tunnel with a **fixed** domain (passkeys are bound to the domain; see `docs/STACK.md`).

## Working rules
- **Privacy first** (above). Run the `privacy-reviewer` agent before merging into `main`.
- **Stay in your area** (`docs/TEAM.md`). Need a change elsewhere? Ask the owner.
- **Verify before integrating.** Read the sponsor docs (`docs/SPONSORS.md`). Never invent an endpoint, header, model ID or claim name; if docs are silent, say so and ask.
- **Testnets only** (Base Sepolia for payments, 0G Galileo for 0G Storage). Secrets only in env (`.env` locally, Render env vars in prod). Only `NEXT_PUBLIC_*` reaches the browser, never a secret.
- **Commits: small and frequent. Message = one short sentence (6–9 words) stating the change.** No body, no `Co-Authored-By` lines.
- **Log AI-assisted work** in `AI_USAGE.md` (ETHGlobal rule), one row per meaningful change.
- **TypeScript ESM**, relative imports with `.js` suffixes. Validate all wire input with zod.
- **Don't implement cryptographic primitives.** Use audited libs (`@noble/*`, ScopeLift SDK, `@docknetwork/crypto-wasm-ts`, WebAuthn/WebCrypto). Composition is fine.
- **0G evidence is mandatory.** Every 0G call records its request ID **and receipt**, logs one line, and stores it in `zg_evidence`. Never drop or swallow them (`docs/STACK.md` "0G evidence").
- **Demo-first.** Every feature must show up in the demo video (2:30–2:55, real voices) or the README.
